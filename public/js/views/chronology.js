/* Chronology view: the full dated event record + CSV export. */
window.Views = window.Views || {};

Views.chronology = async function (campaignId) {
  const view = document.getElementById('view');
  const dash = await API.get('/api/campaigns/' + campaignId);
  const { campaign, client, events } = dash;

  view.innerHTML = `
    <div class="card">
      <a href="#/campaign/${campaign.id}" class="btn-link">← Campaign</a>
      <h2 class="card-title" style="margin-top:8px">Chronology — ${esc(client.name)} vs ${esc(campaign.bureau)}</h2>
      <p class="card-sub">The dated record of every act in this campaign. Certified-letter dates bracketing the bureau's own responses are what proves willfulness — this table is what gets pleaded.</p>
      ${events.length === 0 ? '<p style="color:#64748b;font-style:italic">Nothing logged yet.</p>' : `
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="background:#f8fafc;text-align:left">
          <th style="padding:8px 12px">Date</th><th style="padding:8px 12px">Event</th>
          <th style="padding:8px 12px">Details</th><th style="padding:8px 12px">Evidence</th>
        </tr></thead>
        <tbody>
          ${events.map(e => `
          <tr style="border-bottom:1px solid #f1f5f9">
            <td style="padding:8px 12px;font-family:monospace;white-space:nowrap">${esc(e.event_date)}</td>
            <td style="padding:8px 12px;font-weight:600;white-space:nowrap">${esc(e.type.replace(/_/g, ' '))}</td>
            <td style="padding:8px 12px;overflow-wrap:anywhere">${esc(typeof e.details === 'string' ? e.details : JSON.stringify(e.details || ''))}</td>
            <td style="padding:8px 12px">${e.evidence_path ? esc(e.evidence_path.split(/[\\\\/]/).pop()) : '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>`}
      <button class="btn btn-outline" style="margin-top:16px" onclick="Views._exportChronology(${campaign.id})">Export CSV</button>
    </div>`;

  Views._chronologyEvents = events;
};

Views._exportChronology = function (campaignId) {
  const rows = [['date', 'event', 'details', 'evidence']].concat(
    (Views._chronologyEvents || []).map(e => [
      e.event_date, e.type,
      typeof e.details === 'string' ? e.details : JSON.stringify(e.details || ''),
      e.evidence_path || '',
    ]));
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `chronology_campaign_${campaignId}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
};
