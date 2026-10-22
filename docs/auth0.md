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

## Audience and other authorization parameters

Warden calls no API with the access token, so it doesn't need an audience. If your tenant needs one anyway, set `OIDC_AUDIENCE`. Other authorization parameters go in `OIDC_AUTH_PARAMS` as `key=value` pairs joined by `&` (URL-encode values that contain `&`, `=` or `%`):

```sh
OIDC_AUDIENCE=https://api.example.com
OIDC_AUTH_PARAMS=organization=org_abc123&connection=google-oauth2
```

`organization` signs users in to an [Auth0 Organization](https://auth0.com/docs/manage-users/organizations), `connection` skips the Universal Login chooser, and `prompt=login` always asks for credentials. Warden sets `client_id`, `redirect_uri`, `response_type`, `response_mode`, `scope`, `state`, `nonce`, `code_challenge`, `code_challenge_method`, `request`, and `request_uri` itself, so setting any of them here fails startup.

These parameters are hints in a URL the browser carries, and a user can remove them. They are not an access control: restrict who can sign in with the application's enabled connections and Organization settings in Auth0, and with Warden's `access` rules.
