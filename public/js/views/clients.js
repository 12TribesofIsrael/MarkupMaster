/* Clients list + client detail (identity block + campaigns). */
window.Views = window.Views || {};

const CLIENT_FIELDS = [
  ['name', 'Full name *'], ['address', 'Mailing address'],
  ['phone', 'Phone'], ['phone_alt', 'Second phone'],
  ['email', 'Email'], ['dob', 'Date of birth (MM/DD/YYYY)'],
  ['ssn', 'SSN (or last 4)'], ['former_names', 'Former name(s)'],
  ['proof_of_address', 'Proof of address you mail (e.g. "Delmarva Power bill")'],
  ['id_address', 'Address exactly as printed on the ID / proof of address'],
];

const WIDE_FIELDS = ['address', 'proof_of_address', 'id_address'];

function clientForm(c = {}) {
  return `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
    ${CLIENT_FIELDS.map(([k, label]) => `
      <input id="cf_${k}" placeholder="${esc(label)}" value="${esc(c[k] || '')}"
        style="${WIDE_FIELDS.includes(k) ? 'grid-column:1 / -1;' : ''}padding:10px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px">`).join('')}
  </div>
  <div style="font-size:12px;color:#64748b;margin-top:4px">The full identity block goes on every letter — it blocks the bureaus' "we don't think this is really you" stall. Details stay in the local database on this computer.</div>
  <div style="font-size:12px;color:#64748b;margin-top:4px">The <strong>address as printed on the ID</strong> is what every address on the credit report gets compared against. Leave it blank and the comparison is skipped.</div>`;
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
    </div>
    ${identityDocsCard(client)}`;
};

/* ─── Identity documents (photo ID + proof of address) ───────────────────────── */

const DOC_SLOTS = [
  ['id', 'Government-issued photo ID', 'Driver\'s license, state ID, or passport. Add front and back as two files if your ID has a back.'],
  ['proof', 'Proof of current address', 'Utility bill or bank statement dated within 60 days, showing the name and address.'],
];

function docSlotHtml(client, slot, title, hint) {
  const pages = client[`${slot}_doc_pages`] || [];
  return `
    <div style="border:1px solid #e2e8f0;border-radius:10px;padding:12px">
      <div style="font-weight:700;font-size:14px">${esc(title)}
        ${pages.length ? `<span class="furnisher-badge" style="margin-left:6px">${pages.length} page${pages.length === 1 ? '' : 's'} on file</span>`
                       : '<span style="margin-left:6px;font-weight:400;color:#b45309">not uploaded</span>'}</div>
      <div style="font-size:12px;color:#64748b;margin:4px 0 8px">${esc(hint)}</div>
      ${pages.length ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        ${pages.map(u => `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="${esc(title)} page"
          style="height:96px;border:1px solid #cbd5e1;border-radius:6px;background:#f8fafc"></a>`).join('')}
      </div>` : ''}
      <input type="file" id="doc_${slot}" accept=".jpg,.jpeg,.png,.pdf" multiple
        style="font-size:13px;display:block;margin-bottom:8px">
      <button class="btn btn-outline" onclick="Views._uploadDoc(${client.id},'${slot}')">Upload</button>
      ${pages.length ? `<button class="btn-link" style="margin-left:8px" onclick="Views._removeDoc(${client.id},'${slot}')">Remove</button>` : ''}
    </div>`;
}

function identityDocsCard(client) {
  const missing = DOC_SLOTS.filter(([slot]) => (client[`${slot}_doc_pages`] || []).length === 0);
  return `
    <div class="card">
      <h2 class="card-title">Identity documents</h2>
      <p class="card-sub">These print as exhibit pages at the end of the dispute letter and the full-file request — the letters say the ID and proof of address are enclosed, and this is what makes that true. JPG, PNG, or PDF; PDFs are converted to page images automatically.</p>
      ${missing.length ? `<div style="margin-bottom:12px;padding:10px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;font-size:13px">
        <strong>Not attached yet:</strong> ${missing.map(([, t]) => esc(t.toLowerCase())).join(' and ')}. The letters will still list ${missing.length === 1 ? 'it' : 'them'} as an enclosure, and the mailing instructions will tell the consumer to add ${missing.length === 1 ? 'a copy' : 'copies'} by hand.
      </div>` : ''}
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px">
        ${DOC_SLOTS.map(([slot, title, hint]) => docSlotHtml(client, slot, title, hint)).join('')}
      </div>
    </div>`;
}

Views._uploadDoc = async function (clientId, slot) {
  clearError();
  const input = document.getElementById('doc_' + slot);
  if (!input.files || input.files.length === 0) { showError('Choose a file first.'); return; }
  const fd = new FormData();
  [...input.files].slice(0, 4).forEach(f => fd.append(slot, f));
  try {
    await API.post(`/api/clients/${clientId}/identity-docs`, fd);
    Views.clientDetail(clientId);
  } catch (e) { showError(e.message); }
};

Views._removeDoc = async function (clientId, slot) {
  clearError();
  if (!confirm('Remove these scans? The letters will go back to listing the enclosure without attaching it.')) return;
  try {
    await API.del(`/api/clients/${clientId}/identity-docs/${slot}`);
    Views.clientDetail(clientId);
  } catch (e) { showError(e.message); }
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
