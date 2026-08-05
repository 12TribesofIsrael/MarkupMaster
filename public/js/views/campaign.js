/* Campaign dashboard: rounds, deadline countdowns, timeline, actions. */
window.Views = window.Views || {};

const ROUND_STATUS_LABEL = {
  draft: 'Draft — review & approve the letter',
  approved: 'Approved — ready to mail',
  mailed: 'Mailed — clock running',
  results_received: 'Results received',
  closed: 'Closed',
};

Views.campaign = async function (id) {
  const view = document.getElementById('view');
  const dash = await API.get('/api/campaigns/' + id);
  const { campaign, client, rounds, events, items } = dash;
  const openItems = items.filter(i => ['open'].includes(i.status)).length;
  const verified = items.filter(i => i.status === 'verified_unchanged').length;
  const latest = rounds[rounds.length - 1] || null;
  const canStartAnalysis = !latest || (latest.status === 'results_received' && rounds.length < 3);

  const roundCards = rounds.map(r => {
    const dl = daysUntil(r.deadline_30);
    let clock = '';
    if (r.status === 'mailed' && r.deadline_30) {
      clock = dl >= 0
        ? `<span style="font-weight:700;color:${dl <= 5 ? '#dc2626' : '#0f3460'}">${dl} day${dl === 1 ? '' : 's'} left</span> on the 30-day investigation clock (due ${esc(r.deadline_30)})`
        : `<span style="font-weight:700;color:#dc2626">OVERDUE by ${-dl} day${dl === -1 ? '' : 's'}</span> — no results by ${esc(r.deadline_30)}. Log a follow-up call and consider a CFPB complaint; a no-response is worse for them than a bad investigation.`;
    }
    return `
      <div class="furnisher-item" style="align-items:flex-start">
        <div>
          <div class="furnisher-name">Round ${r.round_number} — ${esc(ROUND_STATUS_LABEL[r.status] || r.status)}</div>
          <div class="furnisher-meta">
            ${r.mail_date ? `mailed ${esc(r.mail_date)}` : 'not mailed yet'}
            ${r.tracking_cra ? ` &bull; tracking ${esc(r.tracking_cra)}` : ''}
            ${r.delivered_date ? ` &bull; delivered ${esc(r.delivered_date)}` : ''}
            ${r.results_received_date ? ` &bull; results ${esc(r.results_received_date)}` : ''}
          </div>
          ${clock ? `<div style="font-size:13px;margin-top:4px">${clock}</div>` : ''}
        </div>
        <button class="btn btn-outline" onclick="location.hash='#/campaign/${campaign.id}/round/${r.id}'">Open</button>
      </div>`;
  }).join('');

  view.innerHTML = `
    <div class="card">
      <a href="#/client/${client.id}" class="btn-link">← ${esc(client.name)}</a>
      <h2 class="card-title" style="margin-top:8px">${esc(campaign.bureau)} campaign</h2>
      <p class="card-sub">
        Status: <strong>${esc(campaign.status)}</strong>
        &bull; ${items.length} tracked item${items.length === 1 ? '' : 's'}
        ${verified ? ` &bull; <span style="color:#dc2626;font-weight:700">${verified} verified-unchanged (litigation core)</span>` : ''}
        ${campaign.sol_deadline ? ` &bull; SOL deadline ${esc(campaign.sol_deadline)}` : ''}
      </p>

      <h3 style="font-size:14px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin:16px 0 8px">Rounds</h3>
      ${roundCards || '<p style="color:#64748b;font-style:italic">No rounds yet — start the Round 1 analysis.</p>'}

      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px">
        ${canStartAnalysis ? `<button class="btn btn-primary" onclick="location.hash='#/campaign/${campaign.id}/analyze'">${rounds.length === 0 ? 'Start Round 1 analysis' : 'Start Round ' + (rounds.length + 1)}</button>` : ''}
        ${latest && latest.status === 'mailed' ? `<button class="btn btn-outline" onclick="Views._logCall(${campaign.id}, ${latest.id})">Log a phone call</button>` : ''}
        ${latest && latest.status === 'mailed' ? `<button class="btn btn-outline" onclick="location.hash='#/campaign/${campaign.id}/intake'">Response intake (results arrived)</button>` : ''}
        <button class="btn btn-outline" onclick="location.hash='#/campaign/${campaign.id}/chronology'">Chronology</button>
      </div>
    </div>

    <div class="card">
      <h2 class="card-title">Timeline</h2>
      <p class="card-sub">Every dated act in this campaign — this is the willfulness record the litigation memo pleads from.</p>
      ${events.length === 0 ? '<p style="color:#64748b;font-style:italic">Nothing logged yet.</p>' : ''}
      ${events.map(e => `
        <div style="display:flex;gap:12px;padding:6px 0;border-bottom:1px solid #f1f5f9;font-size:13px">
          <span style="font-family:monospace;white-space:nowrap">${esc(e.event_date)}</span>
          <strong style="white-space:nowrap">${esc(e.type.replace(/_/g, ' '))}</strong>
          <span style="color:#64748b;overflow-wrap:anywhere">${esc(typeof e.details === 'string' ? e.details : '')}</span>
        </div>`).join('')}
      <button class="btn btn-outline" style="margin-top:12px" onclick="Views._logNote(${campaign.id})">+ Add note / event</button>
    </div>

    <div class="card" style="border:1px solid #fecaca">
      <h2 class="card-title" style="color:#dc2626">Danger zone</h2>
      <button class="btn btn-outline" style="color:#dc2626;border-color:#dc2626" onclick="Views._deleteCampaign(${campaign.id}, ${client.id})">Delete this campaign and all its files</button>
    </div>`;
};

Views._logCall = async function (campaignId, roundId) {
  clearError();
  const date = prompt('Date of the call (YYYY-MM-DD):', todayIso());
  if (!date) return;
  const details = prompt('Who did you speak to, and what was said? (representative name, time, outcome)') || '';
  try {
    await API.post(`/api/campaigns/${campaignId}/events`, { type: 'call_logged', event_date: date, details, round_id: roundId });
    Views.campaign(campaignId);
  } catch (e) { showError(e.message); }
};

Views._logNote = async function (campaignId) {
  clearError();
  const date = prompt('Event date (YYYY-MM-DD):', todayIso());
  if (!date) return;
  const details = prompt('What happened? (e.g. "stall letter received", "pulled new report")') || '';
  if (!details) return;
  try {
    await API.post(`/api/campaigns/${campaignId}/events`, { type: 'note', event_date: date, details });
    Views.campaign(campaignId);
  } catch (e) { showError(e.message); }
};

Views._deleteCampaign = async function (id, clientId) {
  if (!confirm('Delete this campaign, its tracked items, events, and generated files? This cannot be undone.')) return;
  try { await API.del('/api/campaigns/' + id); location.hash = '#/client/' + clientId; }
  catch (e) { showError(e.message); }
};
