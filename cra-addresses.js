// Single source of truth for CRA dispute mailing addresses.
//
// NOTE — two candidate address sets exist in this project's history; verify
// against each bureau's current website before a real mailing:
//   Equifax:    P.O. Box 740256 (this file) vs P.O. Box 740241 (docs/BMB_6-Letter template)
//   TransUnion: Chester, PA 19016 (this file) vs P.O. Box 2000, Chester, PA 19022-2000 (template)
const CRA_ADDRESSES = {
  experian:   { name: 'EXPERIAN INFORMATION SOLUTIONS, INC.', dept: 'Consumer Dispute Center', addr: 'P.O. Box 4500', city: 'Allen, TX 75013', phone: '(888) 397-3742' },
  equifax:    { name: 'EQUIFAX INFORMATION SERVICES, LLC',    dept: 'Office of Consumer Affairs', addr: 'P.O. Box 740256', city: 'Atlanta, GA 30374', phone: '(866) 349-5191' },
  transunion: { name: 'TRANSUNION, LLC',                      dept: 'Consumer Dispute Center', addr: 'P.O. Box 2000', city: 'Chester, PA 19016', phone: '(800) 916-8800' },
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
