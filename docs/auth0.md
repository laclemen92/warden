# Signing in with Auth0

Warden's OIDC support is generic, and Auth0 works with a few settings. This guide covers the Auth0 side, the environment variables, and the `access` config that maps Auth0 roles to Warden roles. See [Authentication](../README.md#authentication) for every sign-in setting.

## 1. Create the application

In the Auth0 dashboard, under **Applications → Applications**, create a **Regular Web Application** (not a Single Page Application: Warden is a server that keeps the client secret). Keep the default token endpoint authentication method (client secret). Under **Settings**:

- **Allowed Callback URLs:** `<WARDEN_PUBLIC_URL>/auth/callback`, e.g. `https://warden.example.com/auth/callback`
- **Allowed Logout URLs:** `<WARDEN_PUBLIC_URL>/`, e.g. `https://warden.example.com/` (with the trailing slash)
- **Allowed Web Origins** and **Allowed Origins (CORS)** can stay empty.

Under **Connections**, enable only the connections whose users should be able to reach Warden. Anyone who can sign in to the application gets past Auth0; the [`access`](config.md#access) config then decides whether they get in to Warden.

## 2. Set the environment

```sh
OIDC_ISSUER=https://your-tenant.us.auth0.com/
OIDC_CLIENT_ID=<Client ID>
OIDC_CLIENT_SECRET=<Client Secret>
OIDC_SCOPES=openid email profile
```

**Write `OIDC_ISSUER` with the trailing slash.** Auth0's issuer (the `iss` claim and the `issuer` in its discovery document) is `https://<domain>/`, and the ID token's `iss` must match it exactly. (A bare `https://<domain>` is normalized to the same URL, but other tools you copy the value into may not do that.) With a [custom domain](https://auth0.com/docs/customize/custom-domains), use it instead: `https://login.example.com/`, and Auth0 issues tokens with that issuer.

The default scopes are enough; roles arrive through an Action (below), not a scope.

## 3. Logout

Logging out of Warden should end the Auth0 session too, or the next person to click "Sign in" on a shared machine is signed straight back in. There are two ways:

- **RP-initiated logout (preferred).** Under **Settings → Advanced** for the tenant, turn on **RP-Initiated Logout End Session Endpoint Discovery**. Auth0 then advertises an `end_session_endpoint` (`/oidc/logout`), and Warden uses it with `id_token_hint` and `post_logout_redirect_uri`. Nothing else to set.
- **Legacy `/v2/logout`.** If you can't change that tenant setting, set

  ```sh
  OIDC_LOGOUT_URL=https://your-tenant.us.auth0.com/v2/logout?client_id={clientId}&returnTo={postLogoutRedirect}
  ```

  Warden fills in `{clientId}` (`OIDC_CLIENT_ID`) and `{postLogoutRedirect}` (`<WARDEN_PUBLIC_URL>/`), URL-encoded. Those are the only placeholders, and only in the query string. The URL must use https and have the same origin as `OIDC_ISSUER` (so use your custom domain here if the issuer uses it); anything else fails startup. It is only used when discovery has no `end_session_endpoint`.

Either way, `<WARDEN_PUBLIC_URL>/` must be in **Allowed Logout URLs**, or Auth0 shows an error instead of returning to Warden.

## 4. Send roles in the ID token

Auth0 doesn't put roles in the ID token by default. Create the roles under **User Management → Roles** and assign them to users, then add a **Post Login** Action (**Actions → Triggers → post-login**) that copies them into a custom claim:

```js
exports.onExecutePostLogin = async (event, api) => {
  // Any URL you control; Auth0 recommends namespacing custom claims.
  const namespace = 'https://warden.example.com';
  api.idToken.setCustomClaim(`${namespace}/roles`, event.authorization?.roles ?? []);
};
```

Deploy it and drag it into the post-login flow. It must set the claim on the **ID token** (`api.idToken`): Warden reads claims from the ID token, not the access token or userinfo.

Then point `groupsClaim` at that claim and map Auth0 role names to Warden roles:

```yaml
access:
  groupsClaim: https://warden.example.com/roles
  groups:
    warden-admins: [admin]
    warden-editors: [editor]
  emailDomains:
    example.com: [viewer]
```

Role names match exactly and are case-sensitive.

## 5. Verified email

Auth0 sends `email` and `email_verified` with the `email` scope. `access.emailDomains` and [role assignments](config.md#role-assignments) only match a verified address ([`requireVerifiedEmail`](config.md#access), on by default). Users of a **Database** connection start with `email_verified: false` until they click the verification link Auth0 emails them, so they won't match an email rule until then. Social and enterprise connections (Google Workspace, Entra ID, SAML) usually report their own verification. Leave `requireVerifiedEmail` on.

## Other authorization parameters

Other authorization parameters go in `OIDC_AUTH_PARAMS` as `key=value` pairs joined by `&` (URL-encode values that contain `&`, `=` or `%`):

```sh
OIDC_AUTH_PARAMS=organization=org_abc123&connection=google-oauth2
```

`organization` signs users in to an [Auth0 Organization](https://auth0.com/docs/manage-users/organizations), `connection` skips the Universal Login chooser, and `prompt=login` always asks for credentials. Warden sets `client_id`, `redirect_uri`, `response_type`, `response_mode`, `scope`, `state`, `nonce`, `code_challenge`, `code_challenge_method`, `request`, and `request_uri` itself, so setting any of them here fails startup.

These parameters are hints in a URL the browser carries, and a user can remove them. They are not an access control: restrict who can sign in with the application's enabled connections and Organization settings in Auth0, and with Warden's `access` rules.

## 6. Calling your API as the user (optional)

When Warden and your API both trust this tenant, Warden can call the API with the signed-in user's own access token. The API then applies the same permissions it applies to its own frontend, and Warden needs no extra trust. Without an audience Warden keeps no access token; skip this section if nothing calls an API.

**Register the API.** Under **Applications → APIs**, create (or open) the API. Its **Identifier** is the audience, e.g. `https://api.example.com`. Then:

```sh
OIDC_AUDIENCE=https://api.example.com
OIDC_SCOPES=openid email profile offline_access
```

One login now yields Warden's ID token plus an access token for the API, and Warden keeps the access token with the session, encrypted under a key derived from the session cookie. Only one audience is supported per deployment. (`audience` in `OIDC_AUTH_PARAMS` works too, but not both.)

**Offline access (refresh tokens).** Auth0 access tokens live 24 hours by default (the API's **Token Expiration**), often less than a Warden session if you shorten it. With `offline_access` in `OIDC_SCOPES` and **Allow Offline Access** turned on in the API's **Settings**, Auth0 also returns a refresh token, and Warden renews the access token when it has less than a minute left, once per session however many requests need it at the same time. Without a refresh token, an expired access token means the user must sign in again. If the refresh fails (the user was blocked or deleted, their refresh tokens were revoked, or it expired), the call fails with "Sign in again to continue"; signing out and in again fixes it. Renewing never extends Warden's own session timeouts.

[Refresh token rotation](https://auth0.com/docs/secure/tokens/refresh-tokens/refresh-token-rotation) (the application's **Refresh Token Rotation** setting) works: Warden keeps the newest refresh token and never uses one twice. Set the refresh token's **Absolute Lifetime** at least as long as `WARDEN_SESSION_ABSOLUTE_TIMEOUT`.

**RBAC permissions.** In the API's **Settings**, turn on **Enable RBAC** and **Add Permissions in the Access Token**. Define permissions (e.g. `refunds:create`) under the API's **Permissions** tab and grant them to the Auth0 roles from step 4. Access tokens for the API then carry a `permissions` claim, which the API checks as it does for any other caller. Warden doesn't read the access token.

**One place decides.** With roles in the ID token (step 4) mapped to Warden roles by `access.groupsClaim`, and the same roles granting API permissions, Auth0 decides both who sees a button in Warden and who may perform the operation in the API. Warden's grants still gate the button; the API's 403 is the final word.

The tokens never reach the browser and are never logged, and they are deleted when the user logs out or an admin signs them out.

## Other identity providers

The same works with any IdP that issues an access token for your API from the authorization code login. Warden keeps the access token only when `OIDC_AUDIENCE` is set, so set it to the API's identifier even where the IdP picks the token's audience from scopes instead: OAuth servers ignore authorization parameters they don't recognize.

- **Okta:** use a custom authorization server (or `default`) whose audience is your API, with `OIDC_ISSUER=https://<org>.okta.com/oauth2/default`. Add the API's scopes and `offline_access` to `OIDC_SCOPES`, and allow the **Refresh Token** grant on the app.
- **Entra ID:** expose an API on its app registration and add its scope (`api://<app-id>/<scope>`) and `offline_access` to `OIDC_SCOPES`. Entra issues one audience per token, so the access token is for that API only.
- **Keycloak:** add an audience mapper (or a client scope with one) so the access token's `aud` includes the API's client. Add `offline_access` to `OIDC_SCOPES` if refresh tokens should outlive the Keycloak SSO session.
