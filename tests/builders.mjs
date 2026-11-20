// Config builders shared by unit and e2e tests. Keep every URL fictional.
let n = 0;
export const rule = o => ({ id: 'r' + (++n), groupId: 'g1', enabled: true, regex: false, actions: [], when: {}, name: o.type + ' ' + n, ...o });
export const config = (rules, groups = [{ id: 'g1', profileId: 'p1', name: 'Group 1', enabled: true }]) =>
  ({ version: 2, activeProfile: 'p1', profiles: [{ id: 'p1', name: 'Profile 1' }], groups, rules });
export const mock = (match, body, o = {}) => rule({
  type: 'mock', match, ...o,
  response: { status: 200, contentType: 'application/json', body, headers: [], delay: 0, ...(o.response || {}) },
});
