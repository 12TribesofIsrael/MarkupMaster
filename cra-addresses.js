// Single source of truth for CRA dispute mailing addresses.
//
// VERIFIED 2026-08-05 against each bureau's own published dispute channel:
//   Experian:   experian.com/disputes/main.html — "Experian, P.O. Box 4500, Allen, TX 75013"
//   Equifax:    assets.equifax.com/assets/personal/Dispute.pdf (official dispute request form) —
//               "Equifax Information Services LLC, P.O. Box 740256, Atlanta, GA 30374"
//               (P.O. Box 740241 is NOT the dispute box — it's used for vendor services)
//   TransUnion: transunion.com/credit-disputes/dispute-your-credit/mail-or-phone —
//               "TransUnion Consumer Solutions, P.O. Box 2000, Chester, PA 19016-2000"
// Re-verify against the same pages before bulk mailings; bureaus move boxes occasionally.
const CRA_ADDRESSES = {
  experian:   { name: 'Experian', dept: '', addr: 'P.O. Box 4500', city: 'Allen, TX 75013', phone: '(888) 397-3742' },
  equifax:    { name: 'Equifax Information Services LLC', dept: '', addr: 'P.O. Box 740256', city: 'Atlanta, GA 30374', phone: '(866) 349-5191' },
  transunion: { name: 'TransUnion', dept: 'Consumer Solutions', addr: 'P.O. Box 2000', city: 'Chester, PA 19016-2000', phone: '(800) 916-8800' },
};

function getCRA(bureauStr) {
  const b = (bureauStr || '').toLowerCase();
  if (b.includes('equifax')) return CRA_ADDRESSES.equifax;
  if (b.includes('trans')) return CRA_ADDRESSES.transunion;
  if (b.includes('experian')) return CRA_ADDRESSES.experian;
  // Bureau resolution in server.js guarantees one of the three before any
  // generator runs — an unknown string here is a programming error, not a
  // case to paper over with a silent Experian default.
  throw new Error(`Unknown bureau: "${bureauStr}"`);
}

module.exports = { CRA_ADDRESSES, getCRA };
