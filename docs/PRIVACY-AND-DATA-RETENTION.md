# Privacy and data retention: DPDP gap report

**This is an engineering review, not legal advice, and it does not say ECHO ECHO complies
with the Digital Personal Data Protection Act, 2023.** A qualified lawyer needs to review it,
including which DPDP Rules apply and from when, because that was not checked here.

## What is held, and for how long

| Data | Who can see it | Retention today | Status |
|---|---|---|---|
| Student profile (name, email, phone, roll number) | The person; `students.view` | No limit | **Gap:** no period set |
| ID card images | Only `students.verify`; never public or presigned | Deleted after 90 days (`ID_IMAGE_RETENTION_DAYS`) | Enforced by the sweeper |
| Partner position | See `DELIVERY-TRACKING.md` | Deleted when the delivery ends; one row, no history | Enforced |
| Location consent | The partner, through export | No limit; holds no coordinates | **Gap:** no period set |
| Orders and delivery addresses | The person; `orders.view` | No limit | **Gap:** legal period needed |
| Support messages | The person; `support.view` | No limit | **Gap:** no period set |
| Team Chat | Conversation members only | No limit | **Gap:** no period set |
| Audit log (includes IP addresses) | `audit.view` | No limit; append-only | **Gap:** no period set |
| Session IP and browser string | `sessions.read`; the person | Until the row is cleared | **Gap:** no pruning |
| Uploaded photos | Public for menu and café; restricted for partner and admin | Until replaced | Metadata now removed on upload |

## Changed in this work

- `GET /me/data-export`: a person's own records as JSON, rate-limited and audited.
- `POST /me/deletion-request`: a recorded request, handled by a person, with the owner recording the
  outcome. **It deletes nothing by itself**, on purpose.
- Exact positions restricted to `delivery.track`, with views audited.
- Consent recorded per delivery before any position is accepted.
- Uploaded images are rebuilt on the server, so EXIF, GPS and trailing data are removed.
- The owner's address is out of `render.yaml`. It is still in Git history, because rewriting a
  public repository's history is destructive and was not done.

## Still open, and who has to act

| Gap | What is needed | Who |
|---|---|---|
| No privacy notice on the student site | Lawyer-reviewed text naming what is collected, why, for how long and how to complain. No text was published here because legal wording should not be invented | Owner, lawyer |
| Consent wording at sign-up | Decide what consent is required, then add a recorded acceptance | Owner, lawyer |
| Retention periods | Decide each "no period set" row above; code can then enforce them | Owner, lawyer, accountant |
| How deletion actually works | Which records must stay (orders, tax, disputes) and which can be erased or anonymised | Owner, lawyer, accountant |
| Grievance contact | Name a person and publish how to reach them | Owner |
| Children's data | Whether anyone under 18 can use the service, which matters for student users | Owner, lawyer |
| Breach response | A written plan, including who must be told and how fast | Owner, lawyer |
| Processors | Agreements with the database, hosting, email, storage and payment providers | Owner |
| Staff access | Periodic review of who holds `students.view`, `delivery.track` and `audit.view` | Owner |
| Partner location notice | Have the in-app notice reviewed; `SHARE_NOTICE_VERSION` records which wording each partner saw | Owner, lawyer |

## Logo

The audit flagged a resemblance between the logo and an existing character. This could not be
assessed here: `brand/logo/` holds the logo but no design files or record of who made it or from
what. This work is not legal clearance. The owner should find the designer's source files, have a
trademark lawyer compare the mark, and commission a distinct mark if needed. The logo was not changed.

## Images

See `docs/IMAGE-ATTRIBUTION.md`.
