# Gmail OAuth2 setup and troubleshooting (n8n, Docker on WSL2)

You said Gmail OAuth currently isn't working. Nothing in this repository depends on it until Phase 5. Until then, deactivate WF00's **Email Alert** node, and WF04 will record `Failed` instead of sending.

I can't see your Google Cloud project or n8n instance, so this is a checklist of the common causes, in the order to try them. It isn't a diagnosis.

## 1. Correct setup

1. **Google Cloud → APIs & Services → Library:** enable the **Gmail API** in the *same* project as the OAuth client.
2. **OAuth consent screen:**
   - With Google Workspace, choose **Internal**. Tokens don't expire weekly, and no verification is needed.
   - With personal Gmail, choose **External** and add the sending address under **Test users**.
3. **Credentials → Create credentials → OAuth client ID → *Web application*.** Under *Authorized redirect URIs*, paste **exactly** the *OAuth Redirect URL* shown in n8n's Gmail credential dialog.
4. In n8n, go to **Credentials → Gmail OAuth2 API**, paste the client ID and secret, click **Sign in with Google**, choose the sending mailbox, and allow every requested scope.

## 2. Symptoms and fixes

| Symptom | Likely cause | Fix |
|---|---|---|
| `Error 400: redirect_uri_mismatch` | The URI in Google Cloud differs from n8n's, by even one character: `http`/`https`, `localhost` vs `127.0.0.1`, the port, or a trailing slash. | Copy the URL from the n8n dialog into Google Cloud and save. Wait a few minutes. If n8n shows a URL like `http://0.0.0.0:5678/...` or a container hostname, set `N8N_HOST=localhost`, `N8N_PROTOCOL=http`, `N8N_PORT=5678`, `WEBHOOK_URL=http://localhost:5678/` on the container the next time you change it, then use the new URL. |
| `Access blocked: … has not completed the Google verification process` / `access_denied` | External app in Testing, and your account isn't a test user | Add the account under **OAuth consent screen → Test users**. |
| Worked, then `invalid_grant` / `Token has been expired or revoked` after about 7 days | External app in **Testing**: refresh tokens expire after 7 days | Reconnect the credential (short term). Long term, use a Workspace **Internal** app, or publish the app ("In production"). Unverified sensitive scopes then show a warning screen but work for your own account. |
| `invalid_grant` right after connecting, or "token used too early" | **The WSL2 clock has drifted** (common after the laptop sleeps) | In PowerShell, run `wsl --shutdown` and restart Docker Desktop. Check that `date` inside WSL matches real time. |
| `403 Gmail API has not been used in project … or it is disabled` | The Gmail API isn't enabled in that project | Enable it (step 1) and wait a few minutes. |
| `403 insufficient permissions` / `insufficientPermissions` | Scopes were unticked during consent | Remove the app at myaccount.google.com → Security → Third-party access, then reconnect and allow every scope. |
| The sign-in pop-up closes with nothing saved | Pop-up blocked, or the browser blocks third-party cookies for `localhost` | Allow pop-ups for `localhost:5678`, or try another browser profile. |
| `unauthorized_client` | The client type isn't *Web application*, or the client ID and secret come from different clients | Create a new *Web application* client and paste both values again. |
| Workspace: "This app is blocked by your admin" | The admin restricts third-party apps | Allow the OAuth client ID in Admin console → Security → API controls. |

## 3. Verify it works, without emailing anyone

1. In a new scratch workflow, add a **Gmail → Get Many Messages** node with `Limit = 1`. Execute it: you should see one message from your inbox.
2. Add a **Gmail → Send** node addressed to **your own** address. Execute it, check that it arrives, and delete the scratch workflow.
3. Only then reconnect the same credential in WF00 *Email Alert*, WF04 *Send Email* and WF05 *Get Recent Messages*.
