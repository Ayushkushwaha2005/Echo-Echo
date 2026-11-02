/* ==========================================================================
   ECHO ECHO - ACCEPTING AN ADMINISTRATOR INVITATION

   Public on purpose: the person has no account yet. The token travels in the
   request body and never in a URL, so it cannot reach an access log. See
   services/admin-invitation.js for the rules and the single activation point.
   ========================================================================== */
import { RATE_LIMITS } from '../config.js';
import {
  openInvitation, sendInvitationCode, verifyInvitationCode, acceptInvitationTerms,
  setInvitationPassword, beginInvitationAuthenticator, completeInvitation,
} from '../services/admin-invitation.js';

export default async function adminInvitationRoutes(app) {
  const limited = { config: { rateLimit: { max: RATE_LIMITS.adminLogin, timeWindow: RATE_LIMITS.windowMinutes * 60_000 }, edgeLimit: true } };

  app.post('/auth/invitation/open', limited, async (req) => openInvitation(req.body?.token));
  app.post('/auth/invitation/email/send', limited, async (req) => sendInvitationCode(req.body?.token, { log: req.log }));
  app.post('/auth/invitation/email/verify', limited, async (req) => verifyInvitationCode(req, req.body?.token, req.body?.code));
  app.post('/auth/invitation/accept', limited, async (req) => acceptInvitationTerms(req, req.body?.token, req.body?.setup));
  app.post('/auth/invitation/password', limited, async (req) => setInvitationPassword(req.body?.token, req.body?.setup, req.body?.password));
  app.post('/auth/invitation/authenticator/begin', limited, async (req) => beginInvitationAuthenticator(req.body?.token, req.body?.setup));
  app.post('/auth/invitation/complete', limited, async (req) => completeInvitation(req, req.body?.token, req.body?.setup, req.body?.code));
}
