/* Clients list + client detail (identity block + campaigns). */
window.Views = window.Views || {};

const CLIENT_FIELDS = [
  ['name', 'Full name *'], ['address', 'Mailing address'],
  ['phone', 'Phone'], ['phone_alt', 'Second phone'],
  ['email', 'Email'], ['dob', 'Date of birth (MM/DD/YYYY)'],
  ['ssn', 'SSN (or last 4)'], ['former_names', 'Former name(s)'],
  ['proof_of_address', 'Proof of address you mail (e.g. "Delmarva Power bill")'],
];

function clientForm(c = {}) {
  return `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
    ${CLIENT_FIELDS.map(([k, label]) => `
      <input id="cf_${k}" placeholder="${esc(label)}" value="${esc(c[k] || '')}"
        style="${k === 'address' || k === 'proof_of_address' ? 'grid-column:1 / -1;' : ''}padding:10px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px">`).join('')}
  </div>
  <div style="font-size:12px;color:#64748b;margin-top:4px">The full identity block goes on every letter — it blocks the bureaus' "we don't think this is really you" stall. Details stay in the local database on this computer.</div>`;
}

function readClientForm() {
  const out = {};
  for (const [k] of CLIENT_FIELDS) out[k] = document.getElementById('cf_' + k).value.trim();
  return out;
}

Views.clients = async function () {
  const view = document.getElementById('view');
  const [clients, campaigns] = await Promise.all([API.get('/api/clients'), API.get('/api/campaigns')]);
  const byClient = {};
  campaigns.forEach(c => { (byClient[c.client_id] = byClient[c.client_id] || []).push(c); });

  view.innerHTML = `
    <div class="card">
      <h2 class="card-title">Clients</h2>
      <p class="card-sub">Each client holds the identity block for their letters. A campaign is one client + one bureau, tracked from first dispute through settlement or suit.</p>
      ${clients.length === 0 ? '<p style="color:#64748b;font-style:italic">No clients yet — add the first one below.</p>' : ''}
      <div>
        ${clients.map(c => `
          <div class="furnisher-item" style="cursor:pointer" onclick="location.hash='#/client/${c.id}'">
            <div>
              <div class="furnisher-name">${esc(c.name)}</div>
              <div class="furnisher-meta">${esc(c.address || 'no address on file')}</div>
            </div>
            <span class="furnisher-badge">${(byClient[c.id] || []).length} campaign${(byClient[c.id] || []).length === 1 ? '' : 's'}</span>
          </div>`).join('')}
      </div>
    </div>
    <div class="card">
      <h2 class="card-title">New client</h2>
      ${clientForm()}
      <button class="btn btn-primary" style="margin-top:12px" onclick="Views._createClient()">Add client</button>
    </div>`;
};

Views._createClient = async function () {
  clearError();
  try {
    const c = await API.post('/api/clients', readClientForm());
    location.hash = '#/client/' + c.id;
  } catch (e) { showError(e.message); }
};

Views.clientDetail = async function (id) {
  const view = document.getElementById('view');
  const [clients, campaigns] = await Promise.all([API.get('/api/clients'), API.get('/api/campaigns')]);
  const client = clients.find(c => c.id === Number(id));
  if (!client) { showError('Client not found.'); location.hash = '#/clients'; return; }
  const mine = campaigns.filter(c => c.client_id === client.id);

  view.innerHTML = `
    <div class="card">
      <a href="#/clients" class="btn-link">← All clients</a>
      <h2 class="card-title" style="margin-top:8px">${esc(client.name)}</h2>
      <h3 style="font-size:14px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin:16px 0 8px">Campaigns</h3>
      ${mine.length === 0 ? '<p style="color:#64748b;font-style:italic">No campaigns yet.</p>' : ''}
      ${mine.map(c => `
        <div class="furnisher-item" style="cursor:pointer" onclick="location.hash='#/campaign/${c.id}'">
          <div>
            <div class="furnisher-name">${esc(c.bureau)}</div>
            <div class="furnisher-meta">round ${c.latest_round || '—'} &bull; ${c.item_count} items &bull; started ${esc((c.created_at || '').slice(0, 10))}</div>
          </div>
          <span class="furnisher-badge">${esc(c.status)}</span>
        </div>`).join('')}
      <div style="display:flex;gap:8px;align-items:center;margin-top:12px">
        <select id="newCampBureau" style="padding:10px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px">
          <option value="Equifax">Equifax</option>
          <option value="Experian">Experian</option>
          <option value="TransUnion">TransUnion</option>
        </select>
        <button class="btn btn-outline" onclick="Views._createCampaign(${client.id})">+ New campaign</button>
      </div>
    </div>
    <div class="card">
      <h2 class="card-title">Identity block</h2>
      ${clientForm(client)}
      <button class="btn btn-primary" style="margin-top:12px" onclick="Views._saveClient(${client.id})">Save</button>
    </div>`;
};

Views._saveClient = async function (id) {
  clearError();
  try { await API.patch('/api/clients/' + id, readClientForm()); Views.clientDetail(id); }
  catch (e) { showError(e.message); }
};

Views._createCampaign = async function (clientId) {
  clearError();
  try {
    const c = await API.post('/api/campaigns', { client_id: clientId, bureau: document.getElementById('newCampBureau').value });
    location.hash = '#/campaign/' + c.id;
  } catch (e) { showError(e.message); }
};
