# Supabase auth email templates

Paste each file into **Supabase → Authentication → Emails → Templates**.
They are plain HTML with no comments, because a Supabase template is
delivered exactly as written — anything you leave in here goes out with the
mail.

| File | Template | Subject to use |
|---|---|---|
| `confirm-signup.html` | Confirm signup | Confirm your SplittyWise account |
| `reset-password.html` | Reset password | Reset your SplittyWise password |
| `change-email.html` | Change email address | Confirm your new SplittyWise address |
| `invite.html` | Invite user | You have been invited to SplittyWise |

## Why they look like this

**Inline styles only.** Gmail and Outlook strip `<style>` blocks, so a
stylesheet would leave the mail unstyled for most people.

**Light colours only, explicitly set.** A dark-themed email gets inverted
unpredictably — Gmail's dark mode will recolour text but not backgrounds, and
white-on-white is a real outcome. Every background and colour here is stated
rather than inherited.

**The link appears twice**, once as a button and once as plain text. Some
clients strip the button, and a link you cannot copy is no link at all.

**520px maximum width**, which is what mobile clients render comfortably
without zooming.

## Variables

Only `{{ .ConfirmationURL }}` is needed, and every template uses it.
`change-email.html` also uses `{{ .Email }}` — the *old* address — so the
recipient can see what they are moving away from. Supabase also offers
`{{ .Token }}` (a 6-digit code), `{{ .TokenHash }}` and `{{ .SiteURL }}`;
none of these templates need them.

## Before you rely on these

Two things matter more than the markup:

1. **The redirect allowlist needs the `/**` wildcard.** The reset link lands
   on `/#/reset`; without the wildcard Supabase refuses the redirect and drops
   people on the home page with no session. README section 4.1.

2. **Supabase's shared sending domain lands in spam.** These templates cannot
   fix that — deliverability is about the sender, not the content. For a
   handful of friends, tell them to check spam. To fix it properly, put your
   own SMTP under **Project Settings → Authentication → SMTP Settings**; the
   same free Brevo account that sends the app's notifications (README 4.7)
   works here too, and then both kinds of mail come from your own address.

Auth mail is also rate-limited to a couple of messages an hour on the free
tier until you set your own SMTP, which is easy to mistake for a broken
template while testing.
