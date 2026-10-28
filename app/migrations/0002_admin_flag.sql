-- App administrator flag (replaces a hard-coded admin email). The first user created by the
-- setup wizard is the administrator; administrators can promote others from Settings → Members.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;
