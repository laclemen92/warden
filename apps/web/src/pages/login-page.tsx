import { Shield } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { ssoLoginUrl } from '@/lib/auth';

// Placeholder until OIDC login (#13): the button hands off to the server's SSO redirect.
export function LoginPage() {
  const [params] = useSearchParams();
  const returnTo = params.get('returnTo');

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-6 rounded-xl border bg-card p-8 text-center shadow-sm">
        <div className="flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Shield className="size-5" />
        </div>
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">Sign in to Warden</h1>
          <p className="text-sm text-muted-foreground">Use your organization's single sign-on.</p>
        </div>
        <Button className="w-full" asChild>
          <a href={ssoLoginUrl(returnTo ?? '/')}>Continue with SSO</a>
        </Button>
      </div>
    </main>
  );
}
