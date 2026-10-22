const { Client } = require('ldapts');

const esc = s => String(s).replace(/[\\*()\0]/g, c => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
const norm = s => String(s || '').trim().toLowerCase();

// Renvoie { name, role } si l'authentification réussit, null sinon. role = null si aucun groupe autorisé.
async function ldapLogin(username, password) {
  const c = new Client({
    url: process.env.LDAP_URL, timeout: 6000, connectTimeout: 6000,
    tlsOptions: { rejectUnauthorized: process.env.LDAP_TLS_REJECT_UNAUTHORIZED !== 'false' },
  });
  try {
    await c.bind(process.env.LDAP_BIND_DN, process.env.LDAP_BIND_PASSWORD);
    const filter = (process.env.LDAP_USER_FILTER || '(uid={{u}})').replace('{{u}}', esc(username));
    const { searchEntries } = await c.search(process.env.LDAP_BASE_DN, {
      scope: 'sub', filter, attributes: ['dn', 'cn', 'displayName', 'memberOf'],
    });
    if (searchEntries.length !== 1) return null;
    const e = searchEntries[0];
    await c.bind(e.dn, password); // échoue si le mot de passe est faux
    const groups = [].concat(e.memberOf || []).map(norm);
    const has = g => g && groups.includes(norm(g));
    const role = has(process.env.LDAP_GROUP_ADMIN) ? 'admin'
      : has(process.env.LDAP_GROUP_MANAGER) ? 'manager'
      : has(process.env.LDAP_GROUP_TECH) ? 'technician' : null;
    return { name: String(e.displayName || e.cn || username), role };
  } catch (err) {
    if (/InvalidCredentials|49/.test(String(err.code) + err.name + err.message)) return null;
    throw err;
  } finally {
    await c.unbind().catch(() => {});
  }
}

module.exports = { ldapLogin };
