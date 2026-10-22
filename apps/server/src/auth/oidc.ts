import * as oidc from 'openid-client';
import { RefreshRejectedError, type ApiTokens } from './session.js';
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
  /** The API audience login requests (`OIDC_AUDIENCE`), whose access token sessions keep. */
  audience: string | undefined;
  /** Fresh checks plus the IdP URL to send the browser to. */
  begin(): Promise<{ url: URL; checks: LoginChecks }>;
  /**
   * Exchange the callback's code and return the validated ID token and its claims, plus the
   * access (and refresh) token when login requests an API audience.
   */
  finish(
    callbackUrl: URL,
    checks: LoginChecks,
  ): Promise<{ claims: oidc.IDToken; idToken: string; apiTokens?: ApiTokens }>;
  /** Renew an access token; throws `RefreshRejectedError` when the IdP refuses the refresh token. */
  refresh(refreshToken: string): Promise<ApiTokens>;
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

  const audience = settings.authParams.audience;
  const apiTokensFrom = (
    tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers,
  ) => {
    const expiresIn = tokens.expiresIn();
    return {
      accessToken: tokens.access_token,
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
      ...(expiresIn !== undefined ? { expiresIn } : {}),
    };
  };

  return {
    redirectUri,
    postLogoutRedirectUri,
    audience,

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
      // Without an audience the access token is only good for userinfo, so it isn't kept.
      return {
        claims,
        idToken: tokens.id_token,
        ...(audience && tokens.access_token ? { apiTokens: apiTokensFrom(tokens) } : {}),
      };
    },

    async refresh(refreshToken) {
      const config = await configuration();
      try {
        return apiTokensFrom(await oidc.refreshTokenGrant(config, refreshToken));
      } catch (err) {
        // An OAuth error (invalid_grant and the like), not an outage.
        if (err instanceof oidc.ResponseBodyError && err.status < 500) {
          throw new RefreshRejectedError(err.error);
        }
        throw err;
      }
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
