/**
 * Shared JSDoc type definitions for Reroute. Nothing here runs: the file only exists so that
 * other modules can write `@param {import('./types.js').Rule} rule` and editors can check it.
 *
 * Every field below is persisted in users' browsers and in exported rules files. Renaming or
 * removing one breaks existing data, so add new optional fields instead and handle them in
 * `normalizeConfig()` in core.js.
 */

/**
 * Which rule kinds exist. Terminal kinds (everything except `rewrite` and `inject`) end the
 * search for a matching rule; rewrites stack on top of whatever else matches.
 *
 * @typedef {'map-remote' | 'map-local' | 'mock' | 'rewrite' | 'block' | 'inject'} RuleType
 */

/**
 * One change a rewrite rule makes.
 *
 * @typedef {object} RewriteAction
 * @property {'req-header' | 'resp-header' | 'query' | 'resp-body' | 'status' | 'delay'} kind
 * @property {string} name Header or query parameter name, or the text to find for `resp-body`.
 * @property {string | number} value New value. An empty header or query value removes it.
 * @property {boolean} [regex] For `resp-body`: treat `name` as a regular expression.
 */

/**
 * Extra conditions a request must meet. Empty arrays and strings mean "any".
 *
 * @typedef {object} RuleConditions
 * @property {string[]} [methods] Upper-case HTTP methods, for example `['GET', 'POST']`.
 * @property {string[]} [resourceTypes] Chrome resource types, see RESOURCE_TYPES in core.js.
 * @property {string[]} [pageDomains] Only when the page making the request is on one of these domains.
 * @property {string} [gql] Only when the request body is this GraphQL operation.
 */

/**
 * A stored response, used by `map-local` and `mock` rules.
 *
 * @typedef {object} StoredResponse
 * @property {number} status HTTP status; 0 simulates a network failure.
 * @property {string} contentType
 * @property {string} body Text, or base64 when `base64` is true.
 * @property {boolean} [base64]
 * @property {string} [fileName] File the body was loaded from, shown in the UI.
 * @property {{ name: string, value: string }[]} headers
 * @property {number} [delay] Milliseconds to wait before answering.
 */

/**
 * Code or styles an inject rule adds to matching pages.
 *
 * @typedef {object} InjectedCode
 * @property {'js' | 'css'} lang
 * @property {'document_start' | 'document_end' | 'document_idle'} runAt
 * @property {string} code
 */

/**
 * A single rule as stored in `rrConfig.rules`.
 *
 * @typedef {object} Rule
 * @property {string} id Stable identifier, unique within a config.
 * @property {string} groupId
 * @property {boolean} enabled
 * @property {RuleType} type
 * @property {string} name
 * @property {string} match URL pattern: `*` wildcards, or a regular expression when `regex` is true.
 * @property {boolean} regex
 * @property {string} [dest] Map-remote destination. `*` (wildcard) or `$1` (regex) take captured text.
 * @property {boolean} [cors] Map-remote: add CORS headers to the destination's responses.
 * @property {RewriteAction[]} actions
 * @property {RuleConditions} when
 * @property {StoredResponse} [response]
 * @property {InjectedCode} [inject]
 */

/**
 * @typedef {object} Group
 * @property {string} id
 * @property {string} profileId
 * @property {string} name
 * @property {boolean} enabled
 */

/**
 * @typedef {object} Profile
 * @property {string} id
 * @property {string} name
 */

/**
 * Everything the user has configured, stored under `rrConfig` and exported as JSON.
 * Array order is priority order: groups first, then rules within a group.
 *
 * @typedef {object} Config
 * @property {number} version
 * @property {string} activeProfile
 * @property {Profile[]} profiles
 * @property {Group[]} groups
 * @property {Rule[]} rules
 */

/**
 * @typedef {object} Settings
 * @property {boolean} masterEnabled
 * @property {number} autoOffMin Minutes until auto-off, 0 for never.
 * @property {number} autoOffAt Epoch milliseconds when Reroute switches off, 0 when not armed.
 */

/**
 * Result of compiling one rule, see `compileRule()`.
 *
 * @typedef {object} CompiledRule
 * @property {object[]} dnr declarativeNetRequest rules (without id and priority).
 * @property {boolean} [page] True when the fetch/XHR hook must handle the rule.
 * @property {string} [error] Why the rule cannot be applied; shown to the user.
 * @property {string[]} notes Plain-language limits of the rule, shown in the editor.
 */

export {};
