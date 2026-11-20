// Reroute core: the rule model, matching and compilation. It must stay pure (no chrome.* calls,
// no DOM) so the service worker, the options page, the popup and the unit tests all share it.

/** @typedef {import('./types.js').Rule} Rule */
/** @typedef {import('./types.js').RewriteAction} RewriteAction */
/** @typedef {import('./types.js').RuleConditions} RuleConditions */
/** @typedef {import('./types.js').StoredResponse} StoredResponse */
/** @typedef {import('./types.js').InjectedCode} InjectedCode */
/** @typedef {import('./types.js').Group} Group */
/** @typedef {import('./types.js').Profile} Profile */
/** @typedef {import('./types.js').Config} Config */
/** @typedef {import('./types.js').Settings} Settings */
/** @typedef {import('./types.js').CompiledRule} CompiledRule */

/**
 * What is known about a request when checking a rule's "Only when…" conditions. A field that is
 * missing is not checked.
 *
 * @typedef {object} RequestContext
 * @property {string} [method] HTTP method.
 * @property {string | string[]} [type] Chrome resource type(s) of the request.
 * @property {string | null} [pageHost] Hostname of the page that made the request.
 * @property {string} [body] Request body, used for GraphQL operation matching.
 */

/**
 * Something about a rule that a reviewer should know. Level `high` rules arrive disabled on import.
 *
 * @typedef {object} Risk
 * @property {'high' | 'info'} level
 * @property {string} text
 */

export const RESOURCE_TYPES = [
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'other',
];
export const TYPE_LABELS = {
  'map-remote': 'Map remote',
  'map-local': 'Map local',
  mock: 'Mock response',
  rewrite: 'Rewrite',
  block: 'Block',
  inject: 'Inject',
};
export const ACTION_KINDS = {
  'req-header': 'Request header',
  'resp-header': 'Response header',
  query: 'Query param',
  'resp-body': 'Response body replace',
  status: 'Status code',
  delay: 'Delay (ms)',
};
export const DEFAULT_SETTINGS = { masterEnabled: true, autoOffMin: 0, autoOffAt: 0 };

// Resource types a data: redirect can serve (documents and fetch/XHR cannot follow one).
const DATA_URL_RESOURCE_TYPES = [
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'media',
  'object',
  'other',
];
const DNR_METHODS = ['connect', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put'];
const PAGE_ACTION_KINDS = ['resp-body', 'status', 'delay'];
const NON_TERMINAL_TYPES = ['rewrite', 'inject'];
const RUN_AT_VALUES = ['document_start', 'document_end', 'document_idle'];
const MAX_DATA_URL_BASE64_LENGTH = 1_500_000;
const BASE64_CHUNK_BYTES = 0x8000;
const DEFAULT_STATUS = 200;
const DEFAULT_CONTENT_TYPE = 'text/plain';
const UNNAMED_RULE = '(unnamed)';
// Rules in groups that no longer exist sort after every real group.
const UNKNOWN_GROUP_POSITION = 1e9;
// declarativeNetRequest priority of the first rule; later rules get lower priorities.
const BASE_DNR_PRIORITY = 100000;
const MS_PER_MINUTE = 60000;
const ALL_URLS = '<all_urls>';
const SECRET_HEADER =
  /^(cookie|set-cookie|authorization|proxy-authorization|x-api-key|x-auth-token)$/i;
const REDACTED_VALUE = 'REDACTED';
const LOCAL_HOSTNAME = /^(localhost|127\.0\.0\.1)$/;
// `*` and `$1` in a destination stand for captured text; a placeholder lets the URL parse.
const CAPTURE_REFERENCE = /\*|\$[0-9]/g;
const REGEX_MATCH_HOST = /^\^?https?\??:\\?\/\\?\/((?:[\w-]|\\\.)+)(?=\\?\/|\$|:|$)/i;
const WILDCARD_MATCH_HOST = /^[a-z*]+:\/\/([^/?#]+)/i;

const MAP_REMOTE_NOTE =
  'Scripts, styles, images and API calls are swapped silently. A redirected document shows the new URL in the address bar — use Full interception to keep the original URL.';
const DATA_URL_NOTE =
  'fetch/XHR get the full response (status, headers, delay). Scripts, styles and images get the body only, and a strict CSP on the page can refuse them. Documents need Full interception. On a page from a different site than the request, fetch/XHR only get it if the page domain is listed under Only when (or with Full interception).';
const FETCH_ONLY_NOTE =
  'Applies to fetch/XHR calls. Other request types need Full interception on the tab. On a page from a different site than the request, fetch/XHR only get it if the page domain is listed under Only when (or with Full interception).';
const GQL_NETWORK_ACTIONS_NOTE =
  'With a GraphQL operation set, header and query actions only apply under Full interception.';
const REWRITE_PAGE_ACTIONS_NOTE =
  'Body, status and delay actions apply to fetch/XHR calls; other request types need Full interception. On a page from a different site than the request, fetch/XHR only get it if the page domain is listed under Only when (or with Full interception).';

/**
 * Creates a short random identifier.
 *
 * @param {string} [prefix] Marks what the id is for: `r` rule (default), `g` group, `p` profile.
 * @returns {string}
 */
export const uid = (prefix = 'r') => prefix + Math.random().toString(36).slice(2, 10);

/**
 * Escapes text so it matches literally inside a regular expression.
 *
 * @param {string} text
 * @returns {string}
 */
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Encodes text as UTF-8 and then base64.
 *
 * @param {unknown} text Converted to a string; null and undefined become ''.
 * @returns {string}
 */
export function utf8ToB64(text) {
  const bytes = new TextEncoder().encode(String(text ?? ''));
  let binary = '';
  // Chunked, because String.fromCharCode.apply has an argument limit.
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + BASE64_CHUNK_BYTES));
  }
  return btoa(binary);
}

/**
 * Decodes base64 that holds UTF-8 text.
 *
 * @param {string} base64
 * @returns {string}
 */
export function b64ToUtf8(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Returns a stored response's body as base64, whether it is stored as text or base64.
 *
 * @param {Partial<StoredResponse> | undefined} response
 * @returns {string}
 */
export const responseB64 = (response) =>
  response?.base64 ? response.body || '' : utf8ToB64(response?.body || '');

// ---------- sites and permissions ----------

/**
 * Guesses the registrable domain of a hostname (no public suffix list): example.com, example.co.uk.
 * page/bridge.js carries the same function — keep them in step.
 *
 * @param {string} hostname
 * @returns {string}
 */
export function siteOf(hostname) {
  const labels = String(hostname).split('.');
  if (labels.length <= 2 || /^\d+$/.test(labels[labels.length - 1])) return String(hostname);
  const labelCount =
    labels[labels.length - 1].length === 2 && labels[labels.length - 2].length <= 3 ? 3 : 2;
  return labels.slice(-labelCount).join('.');
}

/**
 * Finds the host a rule's match pattern is pinned to.
 *
 * @param {Rule} rule
 * @returns {string | null} Lower-case hostname, or null when the rule could match any host.
 */
export function matchHost(rule) {
  const pattern = String(rule.match || '').trim();
  if (rule.regex) {
    const regexHostMatch = pattern.match(REGEX_MATCH_HOST);
    return regexHostMatch ? regexHostMatch[1].replace(/\\\./g, '.').toLowerCase() : null;
  }
  const wildcardHostMatch = pattern.match(WILDCARD_MATCH_HOST);
  if (!wildcardHostMatch) return null;
  let hostname = wildcardHostMatch[1].replace(/:(\d+|\*)$/, '').toLowerCase();
  if (hostname.startsWith('*.')) hostname = hostname.slice(2);
  return !hostname || hostname.includes('*') ? null : hostname;
}

/**
 * Parses a map-remote destination, with captured-text references replaced by a placeholder.
 *
 * @param {unknown} destination
 * @returns {URL}
 * @throws {TypeError} When the destination is not a valid URL.
 */
function parseDestination(destination) {
  return new URL(String(destination).replace(CAPTURE_REFERENCE, 'x'));
}

/**
 * Builds the host permission pattern that covers a hostname and its sibling subdomains.
 *
 * @param {string} hostname
 * @returns {string}
 */
function originPatternFor(hostname) {
  const hasNoDots = !hostname.includes('.');
  const isIpAddress = /^\d+$/.test(hostname.split('.').pop());
  const isStandaloneHost = siteOf(hostname) === hostname && (hasNoDots || isIpAddress);
  return isStandaloneHost ? `*://${hostname}/*` : `*://*.${siteOf(hostname)}/*`;
}

/**
 * Lists the site access the enabled rules need.
 *
 * @param {Config} config
 * @param {Settings} settings
 * @returns {string[]} Host permission patterns, or `['<all_urls>']` when a rule is not pinned to a host.
 */
export function neededOrigins(config, settings) {
  const origins = new Set();
  for (const rule of liveRules(config, settings)) {
    const hostname = matchHost(rule);
    if (!hostname) return [ALL_URLS];
    origins.add(originPatternFor(hostname));
    if (rule.type === 'map-remote') {
      try {
        origins.add(originPatternFor(parseDestination(rule.dest).hostname));
      } catch {
        /* an invalid destination is reported by compileRule() */
      }
    }
    for (const domain of rule.when?.pageDomains || []) origins.add(originPatternFor(domain));
  }
  return [...origins];
}

/**
 * Lists the enabled rules that are not pinned to one host: the reason neededOrigins() asks for
 * access to all sites.
 *
 * @param {Config} config
 * @param {Settings} settings
 * @returns {Rule[]}
 */
export function unpinnedRules(config, settings) {
  return liveRules(config, settings).filter((rule) => !matchHost(rule));
}

/**
 * Checks whether any action of a kind targets a header whose name matches a pattern.
 *
 * @param {RewriteAction[]} actions
 * @param {RewriteAction['kind']} kind
 * @param {RegExp} headerName
 * @returns {boolean}
 */
function hasHeaderAction(actions, kind, headerName) {
  return actions.some((action) => action.kind === kind && headerName.test(action.name));
}

/**
 * Finds where a map-remote rule sends requests, when that is another site.
 *
 * @param {Rule} rule
 * @returns {string | null} The destination hostname, or null when it is the same site or local.
 */
function crossSiteDestination(rule) {
  if (rule.type !== 'map-remote') return null;
  let destinationHost;
  try {
    destinationHost = parseDestination(rule.dest).hostname;
  } catch {
    return null; // no usable destination, so nothing is sent anywhere
  }
  if (!destinationHost || LOCAL_HOSTNAME.test(destinationHost)) return null;
  const sourceHost = matchHost(rule);
  const isSameSite = sourceHost && siteOf(sourceHost) === siteOf(destinationHost);
  return isSameSite ? null : destinationHost;
}

/**
 * Lists what a rule does that a reviewer should know about before trusting it.
 *
 * @param {Rule} rule
 * @returns {Risk[]}
 */
export function riskOf(rule) {
  const risks = [];
  const actions = rule.type === 'rewrite' ? rule.actions || [] : [];
  if (rule.type === 'inject' && rule.inject?.lang !== 'css') {
    risks.push({ level: 'high', text: 'Runs a script on matching pages.' });
  }
  if (hasHeaderAction(actions, 'resp-header', /^content-security-policy/i)) {
    risks.push({ level: 'high', text: 'Removes or changes the page security policy (CSP).' });
  }
  if (rule.cors || hasHeaderAction(actions, 'resp-header', /^access-control-allow-origin$/i)) {
    risks.push({ level: 'info', text: 'Lets other sites read these responses (CORS).' });
  }
  const setsCredentials = actions.some(
    (action) =>
      action.kind === 'req-header' && /^(cookie|authorization)$/i.test(action.name) && action.value,
  );
  if (setsCredentials) {
    risks.push({ level: 'info', text: 'Sets a Cookie or Authorization header.' });
  }
  const destinationHost = crossSiteDestination(rule);
  if (destinationHost) {
    risks.push({ level: 'info', text: 'Sends requests to another site: ' + destinationHost + '.' });
  }
  return risks;
}

/**
 * Removes a stored response's body and secret header values. Mutates the response.
 *
 * @param {StoredResponse} response
 * @returns {void}
 */
function redactResponseInPlace(response) {
  if (response.body) response.fileName ||= 'body removed on export';
  response.body = '';
  response.base64 = false;
  for (const header of response.headers || []) {
    if (SECRET_HEADER.test(header.name) && header.value) header.value = REDACTED_VALUE;
  }
}

/**
 * Removes everything from a rule that can hold secrets. Mutates the rule.
 *
 * @param {Rule} rule
 * @returns {void}
 */
function redactRuleInPlace(rule) {
  if (rule.response) redactResponseInPlace(rule.response);
  for (const action of rule.actions || []) {
    const isSecretHeader = /header/.test(action.kind) && SECRET_HEADER.test(action.name);
    if (isSecretHeader && action.value) action.value = REDACTED_VALUE;
  }
}

/**
 * Makes a copy of a config that is safe to share: no response bodies, no secret header values.
 *
 * @param {Config} config
 * @returns {Config}
 */
export function redactConfig(config) {
  const redacted = structuredClone(config);
  for (const rule of redacted.rules) redactRuleInPlace(rule);
  return redacted;
}

/**
 * Sets or clears the auto-off time. Call whenever the master switch or the auto-off choice
 * changes. Mutates and returns `settings`.
 *
 * @param {Settings} settings
 * @returns {Settings}
 */
export function armAutoOff(settings) {
  const minutes = Number(settings.autoOffMin) || 0;
  settings.autoOffAt = settings.masterEnabled && minutes ? Date.now() + minutes * MS_PER_MINUTE : 0;
  return settings;
}

// ---------- matching ----------

/**
 * Builds the regular expression source for a rule's match pattern. Wildcard matches are exact
 * with `*` as "anything" (same as Charles); a regex is used as written.
 *
 * @param {Rule} rule
 * @returns {{ source: string, groups: number | null }} `groups` is the number of `*` wildcards, or
 *   null for a regex rule.
 */
export function matchSource(rule) {
  const pattern = String(rule.match || '').trim();
  if (rule.regex) return { source: pattern, groups: null };
  const literalParts = pattern.split('*').map(escapeRegex);
  return { source: '^' + literalParts.join('(.*)') + '$', groups: literalParts.length - 1 };
}

/**
 * Compiles a rule's match pattern into a case-insensitive regular expression.
 *
 * @param {Rule} rule
 * @returns {RegExp | null} Null when the user's regex is invalid (compileRule() reports it).
 */
export function jsRegex(rule) {
  try {
    return new RegExp(matchSource(rule).source, 'i');
  } catch {
    return null;
  }
}

/**
 * Joins text parts with numbered group references between them: `a*b*c` → `a$1b$2c`.
 *
 * @param {string[]} parts
 * @param {string} referencePrefix `$` for String.replace, `\` for declarativeNetRequest.
 * @returns {string}
 */
function joinWithGroupReferences(parts, referencePrefix) {
  return parts.reduce(
    (joined, part, index) => (index === 0 ? part : joined + referencePrefix + index + part),
    '',
  );
}

/**
 * Works out where a map-remote rule sends a request. Wildcard rules copy the text matched by each
 * `*` into the matching `*` of the destination; regex rules use `$1`, `$2`… as written.
 *
 * @param {Rule} rule A map-remote rule.
 * @param {string} requestUrl The URL the page asked for.
 * @returns {string | null} The rewritten URL, or null when the rule's pattern is invalid.
 */
export function destFor(rule, requestUrl) {
  const matchPattern = jsRegex(rule);
  if (!matchPattern) return null;
  let destination = String(rule.dest || '').trim();
  if (matchSource(rule).groups !== null) {
    // Escape literal `$` so String.replace does not read it as a group reference.
    destination = joinWithGroupReferences(destination.replace(/\$/g, '$$$$').split('*'), '$');
  }
  return requestUrl.replace(matchPattern, destination);
}

/**
 * Converts a map-remote destination to declarativeNetRequest's regexSubstitution syntax.
 *
 * @param {Rule} rule
 * @returns {string}
 */
function destToDnr(rule) {
  const destination = String(rule.dest || '').trim();
  if (matchSource(rule).groups === null) return destination.replace(/\$([0-9])/g, '\\$1');
  return joinWithGroupReferences(destination.split('*'), '\\');
}

/**
 * Checks whether a request body is a GraphQL request for an operation.
 *
 * @param {string} operationName Matches anything when empty.
 * @param {unknown} body The request body.
 * @returns {boolean}
 */
export function gqlMatch(operationName, body) {
  if (!operationName) return true;
  if (!body || typeof body !== 'string') return false;
  let operations;
  try {
    const parsed = JSON.parse(body);
    operations = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return false; // not JSON, so not a GraphQL request
  }
  const operationPattern = new RegExp(
    '\\b(query|mutation|subscription)\\s+' + escapeRegex(operationName) + '\\b',
  );
  return operations.some(
    (operation) =>
      operation &&
      (operation.operationName === operationName ||
        (typeof operation.query === 'string' && operationPattern.test(operation.query))),
  );
}

/**
 * Checks whether a hostname is one of the domains or a subdomain of one.
 *
 * @param {string[]} domains
 * @param {string} hostname
 * @returns {boolean}
 */
const isOnDomain = (domains, hostname) =>
  domains.some((domain) => hostname === domain || hostname.endsWith('.' + domain));

/**
 * Checks the HTTP method condition.
 *
 * @param {RuleConditions} conditions
 * @param {RequestContext} context
 * @returns {boolean} True when the method condition is met or not checked.
 */
function methodMatches(conditions, context) {
  if (!conditions.methods?.length || !context.method) return true;
  return conditions.methods.includes(context.method.toUpperCase());
}

/**
 * Checks the resource type condition.
 *
 * @param {RuleConditions} conditions
 * @param {RequestContext} context
 * @returns {boolean} True when the resource type condition is met or not checked.
 */
function resourceTypeMatches(conditions, context) {
  if (!conditions.resourceTypes?.length || !context.type) return true;
  const requestTypes = [].concat(context.type);
  return conditions.resourceTypes.some((type) => requestTypes.includes(type));
}

/**
 * Checks the page domain condition.
 *
 * @param {RuleConditions} conditions
 * @param {RequestContext} context
 * @returns {boolean} True when the page domain condition is met or not checked.
 */
function pageDomainMatches(conditions, context) {
  if (!conditions.pageDomains?.length || context.pageHost == null) return true;
  return isOnDomain(conditions.pageDomains, context.pageHost);
}

/**
 * Checks the GraphQL operation condition.
 *
 * @param {RuleConditions} conditions
 * @param {RequestContext} context
 * @returns {boolean} True when the GraphQL operation condition is met or not checked.
 */
function gqlOperationMatches(conditions, context) {
  if (!conditions.gql || context.body === undefined) return true;
  return gqlMatch(conditions.gql, context.body);
}

/**
 * Checks a rule's "Only when…" conditions against a request.
 *
 * @param {Rule} rule
 * @param {RequestContext} [context] What is known about the request; missing fields are not checked.
 * @returns {boolean}
 */
export function whenOk(rule, context = {}) {
  const conditions = rule.when || {};
  return (
    methodMatches(conditions, context) &&
    resourceTypeMatches(conditions, context) &&
    pageDomainMatches(conditions, context) &&
    gqlOperationMatches(conditions, context)
  );
}

/**
 * Orders rules by priority: groups top to bottom, then rules top to bottom inside each group.
 *
 * @param {Config} config
 * @returns {Rule[]}
 */
export function sortedRules(config) {
  const groupPositions = new Map((config.groups || []).map((group, index) => [group.id, index]));
  const positionOf = (rule) => groupPositions.get(rule.groupId) ?? UNKNOWN_GROUP_POSITION;
  return (config.rules || [])
    .map((rule, index) => ({ rule, index }))
    .sort(
      (first, second) =>
        positionOf(first.rule) - positionOf(second.rule) || first.index - second.index,
    )
    .map((entry) => entry.rule);
}

/**
 * Lists the rules that currently apply: enabled, in an enabled group of the active profile, and
 * with Reroute switched on. In priority order.
 *
 * @param {Config} config
 * @param {Settings} settings
 * @returns {Rule[]}
 */
export function liveRules(config, settings) {
  if (!settings?.masterEnabled) return [];
  const groupsById = Object.fromEntries((config.groups || []).map((group) => [group.id, group]));
  return sortedRules(config).filter((rule) => {
    const group = groupsById[rule.groupId];
    return rule.enabled && group && group.enabled && group.profileId === config.activeProfile;
  });
}

// ---------- compilation ----------

/**
 * Checks whether a rewrite action is one the fetch/XHR hook applies, and has something to apply.
 *
 * @param {RewriteAction} action
 * @returns {boolean}
 */
function isUsablePageAction(action) {
  if (!PAGE_ACTION_KINDS.includes(action.kind)) return false;
  const text = action.kind === 'resp-body' ? action.name : action.value || '';
  return String(text) !== '';
}

/**
 * Lists the actions of a rule that the fetch/XHR hook applies.
 *
 * @param {Rule} rule
 * @returns {RewriteAction[]}
 */
const pageActions = (rule) => (rule.actions || []).filter(isUsablePageAction);

/**
 * Lists the resource types a rule applies to, limited to the ones Chrome knows.
 *
 * @param {Rule} rule
 * @returns {string[]}
 */
function allowedResourceTypes(rule) {
  const requestedTypes = rule.when?.resourceTypes;
  if (!requestedTypes?.length) return RESOURCE_TYPES;
  return requestedTypes.filter((type) => RESOURCE_TYPES.includes(type));
}

/**
 * Builds the declarativeNetRequest condition for a rule.
 *
 * @param {Rule} rule
 * @param {string[]} [resourceTypes] Defaults to the rule's own resource types.
 * @returns {object}
 */
function dnrCondition(rule, resourceTypes = allowedResourceTypes(rule)) {
  const conditions = rule.when || {};
  const condition = { regexFilter: matchSource(rule).source, resourceTypes };
  const methods = (conditions.methods || [])
    .map((method) => method.toLowerCase())
    .filter((method) => DNR_METHODS.includes(method));
  if (methods.length) condition.requestMethods = methods;
  if (conditions.pageDomains?.length) condition.initiatorDomains = conditions.pageDomains;
  return condition;
}

/**
 * Builds a compile result for a rule that cannot be applied.
 *
 * @param {string} error Shown to the user.
 * @param {string[]} [notes]
 * @returns {CompiledRule}
 */
const compileError = (error, notes = []) => ({ dnr: [], notes, error });

/**
 * Builds the declarativeNetRequest rule that adds CORS headers to a destination's responses.
 *
 * @param {string} destination
 * @returns {object | null} Null when the destination's origin cannot be worked out.
 */
function destinationCorsRule(destination) {
  let origin;
  try {
    origin = parseDestination(destination).origin;
  } catch {
    return null; // the caller tells the user
  }
  return {
    condition: { urlFilter: '|' + origin + '/', resourceTypes: RESOURCE_TYPES },
    action: { type: 'modifyHeaders', responseHeaders: corsHeaders() },
  };
}

/**
 * Compiles a map-remote rule into a redirect, plus CORS headers when the rule asks for them.
 *
 * @param {Rule} rule
 * @returns {CompiledRule}
 */
function compileMapRemote(rule) {
  const notes = [];
  const destination = String(rule.dest || '').trim();
  if (!destination) return compileError('No destination set.', notes);
  const dnrRules = [
    {
      condition: dnrCondition(rule),
      action: { type: 'redirect', redirect: { regexSubstitution: destToDnr(rule) } },
    },
  ];
  if (rule.cors) {
    const corsRule = destinationCorsRule(destination);
    if (corsRule) dnrRules.push(corsRule);
    else notes.push('Could not work out the destination origin for CORS headers.');
  }
  notes.push(MAP_REMOTE_NOTE);
  return { dnr: dnrRules, page: false, notes };
}

/**
 * Works out which pages may receive a mock through a data: redirect.
 *
 * @param {Rule} rule
 * @returns {string[] | null} Initiator domains, or null when the rule is not pinned to a site.
 */
function dataUrlPageDomains(rule) {
  // Security: same rule as the fetch/XHR hook — only pages on the request's own site, or listed domains.
  if (rule.when?.pageDomains?.length) return rule.when.pageDomains;
  const hostname = matchHost(rule);
  return hostname ? [siteOf(hostname)] : null;
}

/**
 * Builds a data: URL redirect that serves a stored body to scripts, styles and images.
 *
 * @param {Rule} rule A map-local or mock rule.
 * @param {Partial<StoredResponse>} response
 * @returns {object | null} Null when a data: redirect cannot serve this response.
 */
function dataUrlRedirect(rule, response) {
  // Status 0 means "network failure", which a data: URL cannot simulate.
  const status = pageStatus(response.status);
  const dataUrlTypes = allowedResourceTypes(rule).filter((type) =>
    DATA_URL_RESOURCE_TYPES.includes(type),
  );
  const base64Body = responseB64(response);
  const pageDomains = dataUrlPageDomains(rule);
  const canServe =
    status === DEFAULT_STATUS &&
    !rule.when?.gql &&
    dataUrlTypes.length > 0 &&
    base64Body.length <= MAX_DATA_URL_BASE64_LENGTH &&
    pageDomains;
  if (!canServe) return null;
  const contentType = response.contentType || DEFAULT_CONTENT_TYPE;
  return {
    condition: { ...dnrCondition(rule, dataUrlTypes), initiatorDomains: pageDomains },
    action: {
      type: 'redirect',
      redirect: { url: 'data:' + contentType + ';base64,' + base64Body },
    },
  };
}

/**
 * Compiles a map-local or mock rule: the fetch/XHR hook always serves it, and a data: redirect
 * serves other request types where it can.
 *
 * @param {Rule} rule
 * @returns {CompiledRule}
 */
function compileStoredResponse(rule) {
  const response = rule.response || {};
  if (rule.type === 'map-local' && !response.body) {
    return compileError('No content yet — load ' + (response.fileName || 'a file') + '.');
  }
  const redirect = dataUrlRedirect(rule, response);
  if (!redirect) return { dnr: [], page: true, notes: [FETCH_ONLY_NOTE] };
  return { dnr: [redirect], page: true, notes: [DATA_URL_NOTE] };
}

/**
 * Builds a declarativeNetRequest header operation for a header action.
 *
 * @param {RewriteAction} action
 * @returns {object} An empty value removes the header.
 */
function headerOperation(action) {
  if (!action.value) return { header: action.name, operation: 'remove' };
  return { header: action.name, operation: 'set', value: action.value };
}

/**
 * Sorts a rewrite rule's header and query actions into the changes declarativeNetRequest makes.
 *
 * @param {RewriteAction[]} actions
 * @returns {{ requestHeaders: object[], responseHeaders: object[], addParams: object[],
 *   removeParams: string[], notes: string[] }}
 */
function collectNetworkChanges(actions) {
  const changes = {
    requestHeaders: [],
    responseHeaders: [],
    addParams: [],
    removeParams: [],
    notes: [],
  };
  for (const action of actions) {
    const needsName = ['req-header', 'resp-header', 'query'].includes(action.kind);
    if (needsName && !action.name) continue;
    if (action.kind === 'req-header') {
      changes.requestHeaders.push(headerOperation(action));
    } else if (action.kind === 'resp-header') {
      changes.responseHeaders.push(headerOperation(action));
    } else if (action.kind === 'query' && action.value) {
      changes.addParams.push({ key: action.name, value: action.value });
    } else if (action.kind === 'query') {
      changes.removeParams.push(action.name);
    } else if (action.kind === 'req-body') {
      changes.notes.push('Request body rewriting is not supported.');
    }
  }
  return changes;
}

/**
 * Checks whether a rewrite adds or removes query parameters.
 *
 * @param {ReturnType<typeof collectNetworkChanges>} changes
 * @returns {boolean} True when there are query parameters to add or remove.
 */
const hasQueryChanges = (changes) =>
  changes.addParams.length > 0 || changes.removeParams.length > 0;

/**
 * Checks whether a rewrite changes request or response headers.
 *
 * @param {ReturnType<typeof collectNetworkChanges>} changes
 * @returns {boolean} True when there are request or response headers to change.
 */
const hasHeaderChanges = (changes) =>
  changes.requestHeaders.length > 0 || changes.responseHeaders.length > 0;

/**
 * Builds the declarativeNetRequest rules for a rewrite rule's header and query changes.
 *
 * @param {Rule} rule
 * @param {ReturnType<typeof collectNetworkChanges>} changes
 * @returns {object[]}
 */
function networkChangeRules(rule, changes) {
  const dnrRules = [];
  if (hasQueryChanges(changes)) {
    const queryTransform = {};
    if (changes.addParams.length) queryTransform.addOrReplaceParams = changes.addParams;
    if (changes.removeParams.length) queryTransform.removeParams = changes.removeParams;
    dnrRules.push({
      condition: dnrCondition(rule),
      action: { type: 'redirect', redirect: { transform: { queryTransform } } },
    });
  }
  if (hasHeaderChanges(changes)) {
    const action = { type: 'modifyHeaders' };
    if (changes.requestHeaders.length) action.requestHeaders = changes.requestHeaders;
    if (changes.responseHeaders.length) action.responseHeaders = changes.responseHeaders;
    dnrRules.push({ condition: dnrCondition(rule), action });
  }
  return dnrRules;
}

/**
 * Compiles a rewrite rule: header and query changes go to declarativeNetRequest, body, status and
 * delay changes to the fetch/XHR hook.
 *
 * @param {Rule} rule
 * @returns {CompiledRule}
 */
function compileRewrite(rule) {
  const changes = collectNetworkChanges(rule.actions || []);
  const notes = [...changes.notes];
  const hasGqlCondition = !!rule.when?.gql;
  // declarativeNetRequest cannot see request bodies, so GraphQL rules cannot use it.
  const dnrRules = hasGqlCondition ? [] : networkChangeRules(rule, changes);
  if (hasGqlCondition && (hasHeaderChanges(changes) || hasQueryChanges(changes))) {
    notes.push(GQL_NETWORK_ACTIONS_NOTE);
  }
  const usesPageHook = pageActions(rule).length > 0;
  if (!dnrRules.length && !usesPageHook) return compileError('Add at least one action.', notes);
  if (usesPageHook) notes.push(REWRITE_PAGE_ACTIONS_NOTE);
  return { dnr: dnrRules, page: usesPageHook, notes };
}

/**
 * Compiles a block rule.
 *
 * @param {Rule} rule
 * @returns {CompiledRule}
 */
function compileBlock(rule) {
  return {
    dnr: [{ condition: dnrCondition(rule), action: { type: 'block' } }],
    page: false,
    notes: [],
  };
}

/**
 * Checks an inject rule. The service worker injects it on navigation, so nothing is compiled.
 *
 * @param {Rule} rule
 * @returns {CompiledRule}
 */
function compileInject(rule) {
  if (!String(rule.inject?.code || '').trim()) return compileError('Nothing to inject yet.');
  return { dnr: [], page: false, notes: ['The match is tested against the page URL.'] };
}

const RULE_COMPILERS = {
  'map-remote': compileMapRemote,
  'map-local': compileStoredResponse,
  mock: compileStoredResponse,
  rewrite: compileRewrite,
  block: compileBlock,
  inject: compileInject,
};

/**
 * Compiles one rule into declarativeNetRequest rules and diagnostics for the editor.
 *
 * @param {Rule} rule
 * @returns {CompiledRule}
 */
export function compileRule(rule) {
  if (!String(rule.match || '').trim()) return compileError('No match pattern.');
  if (!jsRegex(rule)) return compileError('The match is not a valid regular expression.');
  if (!Object.hasOwn(RULE_COMPILERS, rule.type)) {
    return compileError('Unknown rule type "' + rule.type + '".');
  }
  return RULE_COMPILERS[rule.type](rule);
}

/**
 * Lists the response headers that let any site read a response.
 *
 * @returns {{ header: string, operation: 'set', value: string }[]}
 */
export function corsHeaders() {
  return [
    { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
    { header: 'Access-Control-Allow-Methods', operation: 'set', value: '*' },
    { header: 'Access-Control-Allow-Headers', operation: 'set', value: '*' },
  ];
}

/**
 * Compiles the whole config into declarativeNetRequest session rules. Rule order is priority:
 * earlier rules win.
 *
 * @param {Config} config
 * @param {Settings} settings
 * @param {number[]} [excludedTabIds] Tabs under Full interception, which handles them instead.
 * @returns {{ rules: object[], idMap: Record<number, { ruleId: string, name: string }>,
 *   diag: Record<string, { error: string | null, notes: string[], live: boolean, dnrIds: number[] }> }}
 */
export function compileDnr(config, settings, excludedTabIds = []) {
  const liveRuleIds = new Set(liveRules(config, settings).map((rule) => rule.id));
  const dnrRules = [];
  const sourceByDnrId = {};
  const diagnosticsByRuleId = {};
  let nextDnrId = 1;
  sortedRules(config).forEach((rule, priorityIndex) => {
    const compiled = compileRule(rule);
    const diagnostics = {
      error: compiled.error || null,
      notes: compiled.notes,
      live: liveRuleIds.has(rule.id) && !compiled.error,
      dnrIds: [],
    };
    diagnosticsByRuleId[rule.id] = diagnostics;
    if (!diagnostics.live) return;
    for (const dnrRule of compiled.dnr) {
      const id = nextDnrId++;
      const condition = { ...dnrRule.condition };
      if (excludedTabIds.length) condition.excludedTabIds = excludedTabIds;
      const priority = Math.max(1, BASE_DNR_PRIORITY - priorityIndex);
      dnrRules.push({ id, priority, action: dnrRule.action, condition });
      sourceByDnrId[id] = { ruleId: rule.id, name: rule.name || UNNAMED_RULE };
      diagnostics.dnrIds.push(id);
    }
  });
  return { rules: dnrRules, idMap: sourceByDnrId, diag: diagnosticsByRuleId };
}

/**
 * Checks whether the fetch/XHR hook has to handle a rule.
 *
 * @param {Rule} rule
 * @returns {boolean}
 */
function isHandledByPageHook(rule) {
  const compiled = compileRule(rule);
  if (compiled.error || !compiled.page) return false;
  const resourceTypes = rule.when?.resourceTypes;
  return !resourceTypes?.length || resourceTypes.includes('xmlhttprequest');
}

/**
 * Converts a mock status for the page hook, where 0 means a network failure.
 *
 * @param {number | string | undefined} status
 * @returns {number}
 */
function pageStatus(status) {
  if (status === 0 || status === '0') return 0;
  return Number(status) || DEFAULT_STATUS;
}

/**
 * Converts a stored response into what the page hook serves.
 *
 * @param {Partial<StoredResponse>} response
 * @returns {object}
 */
function toPageResponse(response) {
  return {
    status: pageStatus(response.status),
    contentType: response.contentType || DEFAULT_CONTENT_TYPE,
    body: response.body || '',
    base64: !!response.base64,
    headers: (response.headers || []).filter((header) => header.name),
    delay: Number(response.delay) || 0,
  };
}

/**
 * Converts a rule into the form the page hook (page/bridge.js) holds.
 *
 * @param {Rule} rule
 * @returns {object}
 */
function toPageRule(rule) {
  const conditions = rule.when || {};
  const pageRule = {
    id: rule.id,
    name: rule.name || UNNAMED_RULE,
    src: matchSource(rule).source,
    methods: conditions.methods || [],
    domains: conditions.pageDomains || [],
    gql: conditions.gql || '',
  };
  if (rule.type === 'rewrite') return { ...pageRule, kind: 'rewrite', actions: pageActions(rule) };
  return { ...pageRule, kind: 'mock', response: toPageResponse(rule.response || {}) };
}

/**
 * Compiles the rules the in-page fetch/XHR hook handles. Stored as `rrPage`.
 *
 * @param {Config} config
 * @param {Settings} settings
 * @returns {object[]}
 */
export function compilePage(config, settings) {
  return liveRules(config, settings)
    .filter(isHandledByPageHook)
    .map((rule) => toPageRule(rule));
}

// ---------- tester ----------

/**
 * Describes what a mock rule answers with.
 *
 * @param {Partial<StoredResponse> | undefined} response
 * @returns {string}
 */
function describeMockResponse(response) {
  const status = pageStatus(response?.status);
  if (status === 0) return 'with a network error';
  return status + ' ' + (response?.contentType || DEFAULT_CONTENT_TYPE);
}

/**
 * Describes the file a map-local rule serves.
 *
 * @param {Partial<StoredResponse> | undefined} response
 * @returns {string}
 */
function describeStoredFile(response) {
  const fileName = response?.fileName || 'stored content';
  return fileName + ' (' + (response?.contentType || DEFAULT_CONTENT_TYPE) + ')';
}

/**
 * Describes what a matching rule does to a request, for the URL tester.
 *
 * @param {Rule} rule
 * @param {string} url
 * @returns {string}
 */
function describeOutcome(rule, url) {
  switch (rule.type) {
    case 'map-remote':
      return '→ ' + destFor(rule, url);
    case 'map-local':
      return 'Serves ' + describeStoredFile(rule.response);
    case 'mock':
      return 'Responds ' + describeMockResponse(rule.response);
    case 'block':
      return 'Blocks the request';
    case 'inject':
      return (
        'Injects ' +
        (rule.inject?.lang === 'css' ? 'CSS' : 'JavaScript') +
        ' when this is the page URL'
      );
    default:
      return (rule.actions || [])
        .filter((action) => action.name || action.value)
        .map((action) => ACTION_KINDS[action.kind] || action.kind)
        .join(', ');
  }
}

/**
 * Lists the rules that match a URL and what each would do, for the URL tester.
 *
 * @param {Config} config
 * @param {Settings} settings
 * @param {{ url: string, method?: string, type?: string }} request
 * @returns {{ rule: Rule, outcome: string, shadowed: boolean }[]} `shadowed` is true when an
 *   earlier terminal rule wins instead.
 */
export function testUrl(config, settings, request) {
  const { url, method = 'GET', type = '' } = request;
  const results = [];
  let hasWinner = false;
  for (const rule of liveRules(config, settings)) {
    const matchPattern = jsRegex(rule);
    if (!matchPattern || !matchPattern.test(url)) continue;
    if (!whenOk(rule, { method, type: type || undefined })) continue;
    if (compileRule(rule).error) continue;
    const isTerminal = !NON_TERMINAL_TYPES.includes(rule.type);
    results.push({ rule, outcome: describeOutcome(rule, url), shadowed: isTerminal && hasWinner });
    if (isTerminal) hasWinner = true;
  }
  return results;
}

// ---------- config shape ----------

/**
 * Creates the config a new install starts with: one group of disabled example rules.
 *
 * @returns {Config}
 */
export function seedConfig() {
  const profileId = uid('p');
  const groupId = uid('g');
  const exampleRule = (fields) => ({
    id: uid(),
    groupId,
    enabled: false,
    regex: false,
    actions: [],
    when: {},
    ...fields,
  });
  return {
    version: 2,
    activeProfile: profileId,
    profiles: [{ id: profileId, name: 'Default' }],
    groups: [{ id: groupId, profileId, name: 'Examples', enabled: true }],
    rules: [
      exampleRule({
        type: 'map-remote',
        name: 'Site assets → local dev server',
        match: 'https://www.example.com/assets/*',
        dest: 'http://localhost:3000/assets/*',
        cors: true,
      }),
      exampleRule({
        type: 'mock',
        name: 'Mock user API',
        match: 'https://api.example.com/v1/user*',
        response: {
          status: 200,
          contentType: 'application/json',
          body: '{\n  "id": 1,\n  "name": "Test User"\n}',
          headers: [],
          delay: 0,
        },
      }),
      exampleRule({
        type: 'rewrite',
        name: 'Allow CORS on API',
        match: 'https://api.example.com/*',
        actions: corsHeaders().map((header) => ({
          kind: 'resp-header',
          name: header.header,
          value: header.value,
        })),
      }),
      exampleRule({
        type: 'inject',
        name: 'Hello from Reroute',
        match: 'https://www.example.com/*',
        inject: {
          lang: 'js',
          runAt: 'document_idle',
          code: "console.log('Reroute: script injected');",
        },
      }),
    ],
  };
}

/**
 * Normalizes imported profiles.
 *
 * @param {unknown[] | undefined} rawProfiles
 * @returns {Profile[]} At least one profile.
 */
function normalizeProfiles(rawProfiles) {
  const profiles = (rawProfiles || []).map((profile) => ({
    id: String(profile.id || uid('p')),
    name: profile.name || 'Profile',
  }));
  if (!profiles.length) profiles.push({ id: uid('p'), name: 'Default' });
  return profiles;
}

/**
 * Normalizes imported groups.
 *
 * @param {unknown[] | undefined} rawGroups
 * @param {Profile[]} profiles
 * @param {string} activeProfile Groups of unknown profiles move here.
 * @returns {Group[]} At least one group.
 */
function normalizeGroups(rawGroups, profiles, activeProfile) {
  const groups = (rawGroups || []).map((group) => ({
    id: String(group.id || uid('g')),
    name: group.name || 'Group',
    enabled: group.enabled !== false,
    profileId: profiles.some((profile) => profile.id === group.profileId)
      ? group.profileId
      : activeProfile,
  }));
  if (!groups.length) {
    groups.push({ id: uid('g'), profileId: activeProfile, name: 'Rules', enabled: true });
  }
  return groups;
}

/**
 * Normalizes a rule's "Only when…" conditions.
 *
 * @param {Partial<RuleConditions> | undefined} when
 * @returns {RuleConditions}
 */
function normalizeConditions(when) {
  return {
    methods: (when?.methods || []).map((method) => String(method).toUpperCase()),
    resourceTypes: (when?.resourceTypes || []).filter((type) => RESOURCE_TYPES.includes(type)),
    pageDomains: (when?.pageDomains || []).map(String),
    gql: when?.gql || '',
  };
}

/**
 * Normalizes a rewrite action, converting the v1 cookie-stripping kinds.
 *
 * @param {object} action
 * @returns {RewriteAction}
 */
function normalizeAction(action) {
  if (action.kind === 'strip-req-cookie') return { kind: 'req-header', name: 'Cookie', value: '' };
  if (action.kind === 'strip-resp-cookie') {
    return { kind: 'resp-header', name: 'Set-Cookie', value: '' };
  }
  return {
    kind: action.kind,
    name: action.name || '',
    value: action.value ?? '',
    regex: !!action.regex,
  };
}

/**
 * Normalizes a stored response.
 *
 * @param {object} response
 * @returns {StoredResponse}
 */
function normalizeResponse(response) {
  return {
    status: response.status ?? DEFAULT_STATUS,
    contentType: response.contentType || DEFAULT_CONTENT_TYPE,
    body: response.body || '',
    base64: !!response.base64,
    fileName: response.fileName || '',
    headers: (response.headers || []).map((header) => ({
      name: header.name || '',
      value: header.value || '',
    })),
    delay: Number(response.delay) || 0,
  };
}

/**
 * Normalizes an inject rule's code settings.
 *
 * @param {object} inject
 * @returns {InjectedCode}
 */
function normalizeInject(inject) {
  return {
    lang: inject.lang === 'css' ? 'css' : 'js',
    // Chrome rejects the whole userScripts registration on one unknown runAt value.
    runAt: RUN_AT_VALUES.includes(inject.runAt) ? inject.runAt : 'document_idle',
    code: inject.code || '',
  };
}

/**
 * Normalizes one imported rule.
 *
 * @param {object} rawRule
 * @param {string} id A unique id for the rule.
 * @param {Group[]} groups Rules of unknown groups move to the first group.
 * @returns {Rule}
 */
function normalizeRule(rawRule, id, groups) {
  const rule = {
    id,
    enabled: !!rawRule.enabled,
    regex: !!rawRule.regex,
    name: rawRule.name || '',
    groupId: groups.some((group) => group.id === rawRule.groupId) ? rawRule.groupId : groups[0].id,
    type: Object.hasOwn(TYPE_LABELS, rawRule.type) ? rawRule.type : 'map-remote',
    match: String(rawRule.match || '').trim(),
    when: normalizeConditions(rawRule.when),
    actions: (rawRule.actions || []).map((action) => normalizeAction(action)),
  };
  if (rawRule.dest !== undefined) rule.dest = String(rawRule.dest);
  if (rawRule.cors) rule.cors = true;
  if (rawRule.response) rule.response = normalizeResponse(rawRule.response);
  if (rawRule.inject) rule.inject = normalizeInject(rawRule.inject);
  return rule;
}

/**
 * Normalizes imported rules, skipping non-objects and giving duplicate ids new ones.
 *
 * @param {unknown[]} rawRules
 * @param {Group[]} groups
 * @returns {Rule[]}
 */
function normalizeRules(rawRules, groups) {
  const seenIds = new Set();
  const rules = [];
  for (const rawRule of rawRules) {
    if (!rawRule || typeof rawRule !== 'object') continue;
    let id = String(rawRule.id || uid());
    if (seenIds.has(id)) id = uid();
    seenIds.add(id);
    rules.push(normalizeRule(rawRule, id, groups));
  }
  return rules;
}

/**
 * Validates an imported or stored config and fills in missing fields. Accepts current configs and
 * the v1 rules.json (engine / first extension) format.
 *
 * @param {unknown} raw Parsed JSON.
 * @returns {Config}
 * @throws {Error} When there is no `rules` array.
 */
export function normalizeConfig(raw) {
  if (!raw || !Array.isArray(raw.rules)) throw new Error('No "rules" array found.');
  const profiles = normalizeProfiles(raw.profiles);
  const activeProfile = profiles.some((profile) => profile.id === raw.activeProfile)
    ? raw.activeProfile
    : profiles[0].id;
  const groups = normalizeGroups(raw.groups, profiles, activeProfile);
  return { version: 2, activeProfile, profiles, groups, rules: normalizeRules(raw.rules, groups) };
}
