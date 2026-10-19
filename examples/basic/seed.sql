insert into companies (name, domain, plan)
select
  'Company ' || g,
  'company' || g || '.example',
  (array['free', 'team', 'enterprise'])[1 + g % 3]
from generate_series(1, 25) g;

insert into users (company_id, email, full_name, role, password_hash, is_active, last_login_at)
select
  1 + g % 25,
  'user' || g || '@company' || (1 + g % 25) || '.example',
  'User ' || g,
  (array['member', 'member', 'member', 'admin', 'owner'])[1 + g % 5]::user_role,
  'not-a-real-hash-' || md5(g::text),
  g % 11 <> 0,
  case when g % 4 = 0 then null else now() - (g || ' hours')::interval end
from generate_series(1, 500) g;

insert into orders (company_id, user_id, status, total, notes, placed_at)
select
  1 + g % 25,
  case when g % 9 = 0 then null else 1 + g % 500 end,
  (array['pending', 'paid', 'paid', 'shipped', 'cancelled', 'refunded'])[1 + g % 6]::order_status,
  round((random() * 1000)::numeric, 2),
  case when g % 7 = 0 then 'Gift wrap requested' end,
  now() - (g || ' minutes')::interval
from generate_series(1, 5000) g;
