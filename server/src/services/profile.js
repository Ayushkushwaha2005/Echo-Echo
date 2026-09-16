/* ==========================================================================
   QUAD - STUDENT PROFILE AND CAMPUS

   Whether a profile is complete is a question the SERVER answers, from the
   database row, on every request. There is no stored "complete" flag and no
   request a client can make that declares itself complete: the only way to
   satisfy a requirement is to supply a value that passes validation here.

   Required before ordering:
     name            2-80 characters, letters with spaces . ' -
     student email   a mailbox proven by the email-code flow - OR a VERIFIED
                     status granted by an administrator for a student who
                     could not use their mailbox (see docs/STUDENT-VERIFICATION.md)
     (a contact phone is NOT required here: it is asked for once, at
      checkout, as the delivery contact number - see routes/orders.js)
     campus          a campus_site row; ordering additionally requires that
                     campus to be in service
   ========================================================================== */
import { one, q } from '../db/index.js';
import { BadRequest } from '../auth/rbac.js';

const NAME = /^[A-Za-z][A-Za-z .'-]{0,78}[A-Za-z.]$/;

export function validateName(input) {
  const name = String(input ?? '').trim().replace(/\s+/g, ' ');
  if (!NAME.test(name) || (name.match(/[A-Za-z]/g) || []).length < 2) {
    throw BadRequest('Enter your full name', 'Use letters only, as it appears in university records.');
  }
  return name;
}

/* An Indian mobile number: +91 followed by ten digits starting 6-9. Numbers
   that are one digit repeated are refused as obviously not real. */
export function validateMobile(input) {
  const raw = String(input ?? '').replace(/[\s()-]/g, '');
  let digits = null;
  if (/^\+91[6-9]\d{9}$/.test(raw)) digits = raw.slice(3);
  else if (/^91[6-9]\d{9}$/.test(raw)) digits = raw.slice(2);
  else if (/^0?[6-9]\d{9}$/.test(raw)) digits = raw.slice(-10);
  if (!digits) {
    throw BadRequest('Enter a valid mobile number', 'A 10-digit Indian mobile number starting with 6, 7, 8 or 9.');
  }
  if (/^(\d)\1{9}$/.test(digits)) {
    throw BadRequest('Enter a real mobile number', 'That number is not a valid contact number.');
  }
  return `+91${digits}`;
}

export async function campuses() {
  const { rows } = await q(
    `SELECT id, slug, college_name, name, service_status, status_message, sort
       FROM campus_site ORDER BY sort, name`);
  return rows.map(shapeCampus);
}

export const shapeCampus = (c) => c && ({
  id: c.id, slug: c.slug, collegeName: c.college_name, name: c.name,
  serviceStatus: c.service_status,
  available: c.service_status === 'active',
  message: c.service_status === 'active' ? null
    : c.status_message || `ECHO ECHO is not available at ${c.name} yet.`,
});

/* The profile as the server sees it. `u` is an app_user row (optionally
   joined with its campus). */
export async function profileOf(userId) {
  const u = await one(
    `SELECT u.*, c.slug AS c_slug, c.college_name AS c_college_name, c.name AS c_name,
            c.service_status AS c_service_status, c.status_message AS c_status_message, c.id AS c_id
       FROM app_user u LEFT JOIN campus_site c ON c.id = u.campus_site_id
      WHERE u.id = $1`, [userId]);
  return u ? evaluate(u) : null;
}

export function evaluate(u) {
  const emailOk = !!u.student_email_verified_at;
  /* approved without a proven mailbox can only have come from an
     administrator's decision on an ID card or manual request. */
  const adminVerified = !emailOk && u.student_status === 'approved';
  const contactPhone = u.contact_phone || u.phone || null;
  const missing = [];
  if (!u.name || !NAME.test(u.name)) missing.push('name');
  if (!emailOk && !adminVerified) missing.push('student_email');
  if (!u.campus_site_id) missing.push('campus');
  const campus = u.c_id ? shapeCampus({
    id: u.c_id, slug: u.c_slug, college_name: u.c_college_name, name: u.c_name,
    service_status: u.c_service_status, status_message: u.c_status_message,
  }) : null;
  return {
    complete: missing.length === 0,
    missing,
    name: u.name || null,
    studentEmail: u.student_email || null,
    studentEmailVerified: emailOk,
    verifiedByAdmin: adminVerified,
    contactPhone,
    campus,
  };
}

export const MISSING_COPY = {
  name: 'your full name',
  student_email: 'a verified university student email',
  /* Kept so an older stored value still renders a sentence; nothing adds
     this key any more. A phone number is collected at checkout, where it is
     needed, rather than as a condition of having an account. */
  contact_phone: 'a contact mobile number',
  campus: 'your campus',
};
