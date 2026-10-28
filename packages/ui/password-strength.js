/* ==========================================================================
   ECHO ECHO — PASSWORD STRENGTH HINT (Campus Control)

   Only a hint for the person typing. The server's rule is the authority:
   at least 12 characters, not containing the email, not a common phrase.
   ========================================================================== */
/* A rough strength reading for the new-password field. The server's rule is
   the authority: at least 12 characters, not the email, not common phrases. */
export function passwordStrength(pw) {
  const s = String(pw || '');
  if (!s) return { score: 0, label: '' };
  let score = s.length >= 12 ? 2 : s.length >= 8 ? 1 : 0;
  if (s.length >= 16) score++;
  if (/[a-z]/.test(s) && /[A-Z]/.test(s)) score++;
  if (/\d/.test(s) || /[^A-Za-z0-9\s]/.test(s) || /\s/.test(s.trim())) score++;
  if (s.length < 12) score = Math.min(score, 1);
  return { score: Math.min(4, score), label: ['Too short', 'Weak', 'Fair', 'Good', 'Strong'][Math.min(4, score)] };
}

