# Delivery tracking

## Who sees what

| Viewer | Partner position | Delivery spot | Notes |
|---|---|---|---|
| The partner | Yes | Yes | Their own delivery |
| The customer | Only after pickup | Yes | Their own order; ends with the delivery |
| `delivery.track` | Yes | Yes | Each view audited, at most one row per person, order and 5 minutes |
| `orders.view` only | No (`restricted`) | Name only | No coordinate in the answer |
| Café staff | No | Name only | `GET /orders/:id/delivery-status`: state and first name |
| Anyone else | Refused | Refused | |

Nobody is migrated into `delivery.track`. After this ships, the owner grants it to the
people who need the map.

## Sharing

- **Explicit choice:** the partner taps Start sharing per delivery, after a notice. That
  stores `location_share_consent` (who, which order, when, which notice). The row holds no
  coordinates. Without it the server refuses a position with `sharing_not_started`.
- **One `watchPosition`,** not repeated `getCurrentPosition` calls.
- **Throttle:** at most every 5 s, when moved at least 10 m; otherwise a 20 s heartbeat.
- **Wake Lock** when the browser offers it, requested again when the page returns.
- **Stops on:** Stop sharing, delivery end, sign-out, permission denied or revoked, and
  leaving the partner screen. The stored position goes with it.
- **Tells the partner** about permission loss, no fix for 30 s, network failure and when
  sharing has ended.

## Integrity

- Refused: a fix older than the stored one, the same fix again, older than 120 s, more than
  60 s ahead of the server's clock, off the planet, 0,0, accuracy worse than 2 km, or
  more than 15 km from the café.
- Only one row per partner exists, so no trail can build up.
- Age is measured on the server's clock.

A fix held back by the throttle, or lost to a dropped network, is kept and retried every 5 s, so the last move isn't lost if the phone reports nothing new. A device clock in the wrong unit or year is replaced by the time the fix arrived. Emulated Pixel (Chromium) and iPhone (WebKit) journeys in `tests/browser/journeys/devices.spec.mjs` cover moving, offline and hidden-screen cases. They test the page and the browser engine, not a real phone's GPS, lock screen or battery.

Never done: simulated movement, IP-based positions, or an old position presented as live.
After 60 s the marker goes grey, and after 5 minutes it is not drawn.

## Live updates

`GET /tracking/stream?ticket=` carries only "this order moved". A ticket lasts 60 s and works
once. The stream re-checks the viewer and the order every 15 s and ends when access does.
Viewers then refetch through `/orders/:id/tracking`. Polling always continues.

Streams are **off** unless `LIVE_STREAMS_ENABLED=true`, and while off they answer 204 so
browsers stop retrying. Leave them off until both of these are true:

1. The API is on an always-on instance. An open stream keeps a free instance awake, and
   the wake delay (measured at 12.97 s in the audit) would hit every first viewer.
2. Vercel's proxy is shown to pass a long response. This has not been tested.

## Routes and arrival times

The map draws a direct line and says it is not a route. No arrival time is shown, because
no real delivery data exists to calibrate one. Neither should change until campus paths are
mapped and real deliveries have been measured.

## Physical-device checklist: NOT DONE

No physical phone was available, so none of this has been run. **Do not treat tracking
as proven on real phones until someone completes it**, with consenting people, on at least one
Android phone and one iPhone:

- [ ] Permission denied at the first prompt
- [ ] Permission revoked in settings mid-delivery
- [ ] Screen locked for 2 minutes, then unlocked
- [ ] Browser sent to the background, then back
- [ ] Airplane mode for 1 minute, then back
- [ ] Viewer sees the marker age, then go grey, and never see it shown as fresh
- [ ] Delivery completes: sharing stops and the map stops showing a position
- [ ] Battery use over 30 minutes (target under 10% per hour)
- [ ] Time from a fix on the phone to the admin screen (target 95% under 3 s)

What automated tests do cover is listed in `docs/TEST-RESULTS.md`. They use a simulated
phone, so they prove the rules and not how a locked iPhone behaves.
