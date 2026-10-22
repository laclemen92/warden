import * as oidc from 'openid-client';
import { buildLogoutUrl, type AuthSettings } from './settings.js';

/** Per-login values kept in the browser between /auth/login and /auth/callback. */
export interface LoginChecks {
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface OidcClient {
  redirectUri: string;
  /** Where the IdP sends the browser after logging out; register it at the IdP. */
  postLogoutRedirectUri: string;
  /** Fresh checks plus the IdP URL to send the browser to. */
  begin(): Promise<{ url: URL; checks: LoginChecks }>;
  /** Exchange the callback's code and return the validated ID token and its claims. */
  finish(callbackUrl: URL, checks: LoginChecks): Promise<{ claims: oidc.IDToken; idToken: string }>;
  /**
   * The IdP's logout URL (RP-initiated logout), so it ends its own session too. Falls back to
   * `OIDC_LOGOUT_URL` without an `end_session_endpoint`; `undefined` when neither exists.
   */
  endSessionUrl(idToken?: string): Promise<URL | undefined>;
}

export function createOidcClient(settings: AuthSettings): OidcClient {
  const redirectUri = new URL('/auth/callback', settings.publicUrl).href;
  const postLogoutRedirectUri = new URL('/', settings.publicUrl).href;
  // Settings only allow http for loopback issuers.
  const options =
    settings.issuer.protocol === 'http:' ? { execute: [oidc.allowInsecureRequests] } : {};

  // Discovered lazily and retried after failure, so an IdP outage doesn't stop Warden starting.
  let discovered: Promise<oidc.Configuration> | undefined;
  const configuration = () =>
    (discovered ??= oidc
      .discovery(settings.issuer, settings.clientId, settings.clientSecret, undefined, options)
      .catch((err: unknown) => {
        discovered = undefined;
        throw err;
      }));

  return {
    redirectUri,
    postLogoutRedirectUri,

    async begin() {
      const config = await configuration();
      const checks: LoginChecks = {
        state: oidc.randomState(),
        nonce: oidc.randomNonce(),
        codeVerifier: oidc.randomPKCECodeVerifier(),
      };
      const url = oidc.buildAuthorizationUrl(config, {
        ...settings.authParams,
        redirect_uri: redirectUri,
        scope: settings.scopes,
        state: checks.state,
        nonce: checks.nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(checks.codeVerifier),
        code_challenge_method: 'S256',
      });
      return { url, checks };
    },

    async finish(callbackUrl, checks) {
      const config = await configuration();
      const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: checks.codeVerifier,
        expectedState: checks.state,
        expectedNonce: checks.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims || !tokens.id_token) throw new Error('token response has no ID token');
      return { claims, idToken: tokens.id_token };
    },

    async endSessionUrl(idToken) {
      const config = await configuration();
      if (!config.serverMetadata().end_session_endpoint) {
        return settings.logoutUrl
          ? buildLogoutUrl(settings.logoutUrl, {
              clientId: settings.clientId,
              postLogoutRedirect: postLogoutRedirectUri,
            })
          : undefined;
      }
      // buildEndSessionUrl adds client_id, which some IdPs need when the hint is missing.
      return oidc.buildEndSessionUrl(config, {
        post_logout_redirect_uri: postLogoutRedirectUri,
        ...(idToken ? { id_token_hint: idToken } : {}),
      });
    },
  };
}
