-- Cirrus icing awareness course (required for flight into known icing; good for 24 calendar months).
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS icing_course_date DATE;
