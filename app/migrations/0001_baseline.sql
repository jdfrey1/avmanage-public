-- avManage baseline schema.
--
-- The complete schema as of the first public release, generated with
--   pg_dump --schema-only --no-owner --no-privileges
-- Later changes go in new numbered files in this folder; the app applies any that haven't
-- run yet at startup (see app/migrate.js). Never edit a migration that has been released.

--
-- PostgreSQL database dump
--



SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: update_ledger_running_balance(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_ledger_running_balance() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    prev_balance NUMERIC(10,2);
    delta NUMERIC(10,2);
BEGIN
    SELECT running_balance INTO prev_balance
    FROM financial_ledger
    WHERE partnership_id = NEW.partnership_id
    ORDER BY effective_date DESC, created_at DESC
    LIMIT 1;

    IF prev_balance IS NULL THEN
        prev_balance := 0;
    END IF;

    IF NEW.direction = 'credit' THEN
        delta := NEW.amount;
    ELSE
        delta := -NEW.amount;
    END IF;

    NEW.running_balance := prev_balance + delta;
    RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: currency_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.currency_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    partnership_id uuid NOT NULL,
    event_date date NOT NULL,
    event_type text NOT NULL,
    landings_day integer DEFAULT 0,
    landings_night integer DEFAULT 0,
    approaches integer DEFAULT 0,
    holds_accomplished boolean DEFAULT false,
    source text NOT NULL,
    related_flight_id uuid,
    aircraft_type text,
    certificate_expires date,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    aircraft_class text,
    CONSTRAINT currency_events_event_type_check CHECK ((event_type = ANY (ARRAY['day_landing'::text, 'night_landing'::text, 'ifr_session'::text, 'bfr'::text, 'medical'::text, 'ipc'::text]))),
    CONSTRAINT currency_events_source_check CHECK ((source = ANY (ARRAY['auto_flight'::text, 'manual'::text, 'foreflight_import'::text])))
);


--
-- Name: document_pages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_pages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid NOT NULL,
    partnership_id uuid NOT NULL,
    page_number integer NOT NULL,
    text text NOT NULL,
    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, COALESCE(text, ''::text))) STORED,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    partnership_id uuid NOT NULL,
    uploaded_by uuid NOT NULL,
    doc_type text NOT NULL,
    title text NOT NULL,
    file_key text NOT NULL,
    expires_at date,
    warn_days_before integer DEFAULT 30,
    cost_amount numeric(10,2),
    cost_category text,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    extracted_text text,
    text_status text DEFAULT 'pending'::text NOT NULL,
    text_error text,
    drive_file_id text,
    CONSTRAINT documents_cost_category_check CHECK ((cost_category = ANY (ARRAY['maintenance'::text, 'insurance'::text, 'hangar'::text, 'avionics'::text, 'fuel'::text, 'misc'::text]))),
    CONSTRAINT documents_doc_type_check CHECK ((doc_type = ANY (ARRAY['lease'::text, 'insurance'::text, 'registration'::text, 'receipt'::text, 'other'::text, 'airworthiness_certificate'::text, 'radio_station_license'::text, 'operating_limitations'::text, 'weight_and_balance'::text, 'miscellaneous'::text, 'invoice'::text]))),
    CONSTRAINT documents_text_status_check CHECK ((text_status = ANY (ARRAY['pending'::text, 'ready'::text, 'partial'::text, 'skipped'::text, 'error'::text])))
);


--
-- Name: financial_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.financial_ledger (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    partnership_id uuid NOT NULL,
    entry_type text NOT NULL,
    direction text NOT NULL,
    amount numeric(10,2) NOT NULL,
    running_balance numeric(10,2) DEFAULT 0 NOT NULL,
    effective_date date NOT NULL,
    related_flight_id uuid,
    related_document_id uuid,
    description text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    lessee_id uuid,
    auto_key text,
    CONSTRAINT financial_ledger_amount_check CHECK ((amount >= (0)::numeric)),
    CONSTRAINT financial_ledger_direction_check CHECK ((direction = ANY (ARRAY['debit'::text, 'credit'::text])))
);


--
-- Name: flightaware_flights; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.flightaware_flights (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    partnership_id uuid NOT NULL,
    tail text NOT NULL,
    dep_msg_id text,
    arr_msg_id text,
    origin text,
    destination text,
    off_time timestamp with time zone,
    on_time timestamp with time zone,
    en_route_min integer,
    url text,
    flight_id uuid,
    fa_flight_id text,
    track jsonb,
    track_status text,
    track_tries integer DEFAULT 0 NOT NULL,
    track_fetched_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    ignored boolean DEFAULT false NOT NULL
);


--
-- Name: flights; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.flights (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    partnership_id uuid NOT NULL,
    pilot_id uuid NOT NULL,
    flight_date date NOT NULL,
    tach_start numeric(8,1) NOT NULL,
    tach_end numeric(8,1) NOT NULL,
    tach_time numeric(6,1) GENERATED ALWAYS AS ((tach_end - tach_start)) STORED,
    hobbs_start numeric(8,1),
    hobbs_end numeric(8,1),
    fuel_gallons numeric(6,2),
    tks_gallons numeric(6,2) DEFAULT 0,
    fuel_standard_met boolean,
    ocr_source_image_key text,
    notes text,
    currency_event_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    route text,
    google_event_id text,
    drive_file_id text,
    flight_time numeric(6,1) GENERATED ALWAYS AS ((hobbs_end - hobbs_start)) STORED,
    exclude_from_allotment boolean DEFAULT false NOT NULL,
    oil_added_quarts numeric(3,1),
    fuel_added_gallons numeric(5,1),
    CONSTRAINT flights_check CHECK ((tach_end >= tach_start))
);


--
-- Name: google_calendar_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.google_calendar_config (
    id integer DEFAULT 1 NOT NULL,
    client_id text NOT NULL,
    client_secret text NOT NULL,
    calendar_id text NOT NULL,
    refresh_token text,
    connected_at timestamp with time zone,
    connected_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    drive_root_folder_id text,
    drive_folder_ids jsonb,
    CONSTRAINT google_calendar_config_id_check CHECK ((id = 1))
);


--
-- Name: inspection_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inspection_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    partnership_id uuid NOT NULL,
    title text NOT NULL,
    notes text,
    interval_months integer,
    last_done_date date,
    due_date date,
    warn_days integer DEFAULT 30 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: invoice_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoice_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    invoice_id uuid NOT NULL,
    item_no integer NOT NULL,
    status text NOT NULL,
    item_date date,
    description text NOT NULL,
    work_performed text,
    labor_hours numeric(6,1),
    labor_rate numeric(8,2),
    labor_amount numeric(10,2),
    parts jsonb DEFAULT '[]'::jsonb NOT NULL,
    parts_amount numeric(10,2),
    total_amount numeric(10,2),
    search_vector tsvector GENERATED ALWAYS AS (((setweight(to_tsvector('english'::regconfig, COALESCE(description, ''::text)), 'A'::"char") || setweight(to_tsvector('english'::regconfig, COALESCE(work_performed, ''::text)), 'B'::"char")) || setweight(to_tsvector('english'::regconfig, ((COALESCE((jsonb_path_query_array(parts, '$[*]."description"'::jsonpath))::text, ''::text) || ' '::text) || COALESCE((jsonb_path_query_array(parts, '$[*]."part"'::jsonpath))::text, ''::text))), 'C'::"char"))) STORED
);


--
-- Name: invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invoices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    partnership_id uuid NOT NULL,
    document_id uuid NOT NULL,
    vendor text NOT NULL,
    invoice_number text NOT NULL,
    invoice_date date,
    customer text,
    summary text,
    responsible text,
    labor numeric(10,2),
    parts numeric(10,2),
    shipping numeric(10,2),
    tax numeric(10,2),
    total numeric(10,2) NOT NULL,
    total_time numeric(8,1),
    hobbs numeric(8,1),
    flight_timer numeric(8,1),
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ledger_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_documents (
    ledger_id uuid NOT NULL,
    document_id uuid NOT NULL
);


--
-- Name: ledger_invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_invoices (
    ledger_id uuid NOT NULL,
    invoice_id uuid NOT NULL
);


--
-- Name: logbook_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.logbook_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    partnership_id uuid NOT NULL,
    category text NOT NULL,
    source_filename text NOT NULL,
    file_key text NOT NULL,
    page_count integer,
    status text DEFAULT 'pending'::text NOT NULL,
    error_message text,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    drive_file_id text,
    CONSTRAINT logbook_documents_category_check CHECK ((category = ANY (ARRAY['engine'::text, 'airframe'::text, 'prop'::text, 'ad_sb_compliance'::text, 'other'::text]))),
    CONSTRAINT logbook_documents_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processed'::text, 'error'::text])))
);


--
-- Name: logbook_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.logbook_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid NOT NULL,
    partnership_id uuid NOT NULL,
    category text NOT NULL,
    page_number integer,
    entry_date date,
    summary text NOT NULL,
    raw_text text NOT NULL,
    fields jsonb DEFAULT '{}'::jsonb NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    needs_review boolean DEFAULT true NOT NULL,
    reviewed_at timestamp with time zone,
    search_vector tsvector GENERATED ALWAYS AS ((setweight(to_tsvector('english'::regconfig, COALESCE(summary, ''::text)), 'A'::"char") || setweight(to_tsvector('english'::regconfig, COALESCE(raw_text, ''::text)), 'B'::"char"))) STORED,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    invoice_id uuid
);


--
-- Name: maintenance_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maintenance_attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    partnership_id uuid NOT NULL,
    parent_type text NOT NULL,
    parent_id uuid NOT NULL,
    file_key text NOT NULL,
    mime_type text NOT NULL,
    original_name text,
    uploaded_by uuid NOT NULL,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    drive_file_id text,
    CONSTRAINT maintenance_attachments_parent_type_check CHECK ((parent_type = ANY (ARRAY['log'::text, 'squawk'::text])))
);


--
-- Name: maintenance_intervals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maintenance_intervals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    partnership_id uuid NOT NULL,
    title text NOT NULL,
    description text,
    interval_hours numeric(6,1) NOT NULL,
    last_done_hours numeric(8,1) NOT NULL,
    last_done_date date,
    warn_hours numeric(6,1) DEFAULT 10 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT maintenance_intervals_interval_hours_check CHECK ((interval_hours > (0)::numeric))
);


--
-- Name: maintenance_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maintenance_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    partnership_id uuid NOT NULL,
    item_type text NOT NULL,
    name text NOT NULL,
    ad_number text,
    interval_days integer,
    interval_tach_hrs numeric(6,1),
    last_completed_date date,
    last_completed_tach numeric(8,1),
    next_due_date date,
    next_due_tach numeric(8,1),
    warn_days_before integer DEFAULT 30,
    warn_tach_before numeric(5,1) DEFAULT 10,
    document_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT maintenance_items_item_type_check CHECK ((item_type = ANY (ARRAY['recurring'::text, 'ad'::text, 'tbo'::text])))
);


--
-- Name: maintenance_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maintenance_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    partnership_id uuid NOT NULL,
    entry_date date NOT NULL,
    category text NOT NULL,
    title text NOT NULL,
    description text,
    cost_amount numeric(10,2),
    tach_at_service numeric(8,1),
    performed_by text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT maintenance_log_category_check CHECK ((category = ANY (ARRAY['maintenance'::text, 'insurance'::text, 'avionics'::text, 'hangar'::text, 'fuel'::text, 'misc'::text])))
);


--
-- Name: maintenance_recurring; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.maintenance_recurring (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    partnership_id uuid NOT NULL,
    category text NOT NULL,
    title text NOT NULL,
    description text,
    cost_amount numeric(10,2) NOT NULL,
    day_of_month integer DEFAULT 1 NOT NULL,
    next_due_date date NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT maintenance_recurring_category_check CHECK ((category = ANY (ARRAY['maintenance'::text, 'insurance'::text, 'avionics'::text, 'hangar'::text, 'fuel'::text, 'misc'::text]))),
    CONSTRAINT maintenance_recurring_cost_amount_check CHECK ((cost_amount > (0)::numeric)),
    CONSTRAINT maintenance_recurring_day_of_month_check CHECK (((day_of_month >= 1) AND (day_of_month <= 28)))
);


--
-- Name: partnership_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.partnership_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    partnership_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    lease_monthly_rate numeric(10,2),
    annual_hour_allotment integer,
    overage_rate_per_hr numeric(8,2),
    lease_start_date date,
    hour_allotment_period text DEFAULT 'annual'::text NOT NULL,
    CONSTRAINT partnership_members_hour_allotment_period_check CHECK ((hour_allotment_period = ANY (ARRAY['annual'::text, 'monthly'::text]))),
    CONSTRAINT partnership_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'lessee'::text])))
);


--
-- Name: partnerships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.partnerships (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    aircraft_tail text,
    aircraft_make_model text,
    aircraft_serial text,
    tach_at_purchase numeric(8,1),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    insurance_expires_date date,
    baseline_hobbs numeric(8,1),
    baseline_flight numeric(8,1),
    baseline_date date,
    baseline_image_key text
);


--
-- Name: password_resets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_resets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: recurring_charges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recurring_charges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    partnership_id uuid NOT NULL,
    lessee_id uuid NOT NULL,
    entry_type text NOT NULL,
    direction text NOT NULL,
    amount numeric(10,2) NOT NULL,
    description_template text NOT NULL,
    day_of_month integer DEFAULT 1 NOT NULL,
    next_due_date date NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recurring_charges_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT recurring_charges_day_of_month_check CHECK (((day_of_month >= 1) AND (day_of_month <= 28))),
    CONSTRAINT recurring_charges_direction_check CHECK ((direction = ANY (ARRAY['debit'::text, 'credit'::text])))
);


--
-- Name: schedule_blocks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schedule_blocks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    partnership_id uuid NOT NULL,
    created_by uuid NOT NULL,
    block_type text NOT NULL,
    start_dt timestamp with time zone NOT NULL,
    end_dt timestamp with time zone NOT NULL,
    title text NOT NULL,
    notes text,
    delivery_ack_at timestamp with time zone,
    return_ack_at timestamp with time zone,
    delivery_tach numeric(8,1),
    return_tach numeric(8,1),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_all_day boolean DEFAULT false NOT NULL,
    pilot_id uuid,
    pilot_name text,
    google_event_id text,
    CONSTRAINT schedule_blocks_block_type_check CHECK ((block_type = ANY (ARRAY['reservation'::text, 'maintenance'::text, 'unavailable'::text]))),
    CONSTRAINT schedule_blocks_check CHECK ((end_dt > start_dt))
);


--
-- Name: session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session (
    sid character varying NOT NULL,
    sess json NOT NULL,
    expire timestamp(6) without time zone NOT NULL
);


--
-- Name: squawks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.squawks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    partnership_id uuid NOT NULL,
    reported_by uuid NOT NULL,
    description text NOT NULL,
    severity text NOT NULL,
    tach_at_report numeric(8,1),
    status text DEFAULT 'open'::text NOT NULL,
    resolved_at timestamp with time zone,
    resolution_notes text,
    reported_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT squawks_severity_check CHECK ((severity = ANY (ARRAY['major'::text, 'minor'::text, 'note'::text]))),
    CONSTRAINT squawks_status_check CHECK ((status = ANY (ARRAY['open'::text, 'in_progress'::text, 'resolved'::text])))
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    name text NOT NULL,
    phone text,
    password_hash text NOT NULL,
    push_subscription jsonb,
    last_foreflight_import_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    calendar_token uuid DEFAULT gen_random_uuid(),
    medical_expires_date date,
    is_active boolean DEFAULT true NOT NULL,
    last_foreflight_import_file text,
    bfr_date date,
    currency_alerts_enabled boolean DEFAULT true NOT NULL
);


--
-- Name: currency_events currency_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.currency_events
    ADD CONSTRAINT currency_events_pkey PRIMARY KEY (id);


--
-- Name: document_pages document_pages_document_id_page_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_pages
    ADD CONSTRAINT document_pages_document_id_page_number_key UNIQUE (document_id, page_number);


--
-- Name: document_pages document_pages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_pages
    ADD CONSTRAINT document_pages_pkey PRIMARY KEY (id);


--
-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);


--
-- Name: financial_ledger financial_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.financial_ledger
    ADD CONSTRAINT financial_ledger_pkey PRIMARY KEY (id);


--
-- Name: flightaware_flights flightaware_flights_arr_msg_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flightaware_flights
    ADD CONSTRAINT flightaware_flights_arr_msg_id_key UNIQUE (arr_msg_id);


--
-- Name: flightaware_flights flightaware_flights_dep_msg_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flightaware_flights
    ADD CONSTRAINT flightaware_flights_dep_msg_id_key UNIQUE (dep_msg_id);


--
-- Name: flightaware_flights flightaware_flights_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flightaware_flights
    ADD CONSTRAINT flightaware_flights_pkey PRIMARY KEY (id);


--
-- Name: flights flights_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flights
    ADD CONSTRAINT flights_pkey PRIMARY KEY (id);


--
-- Name: google_calendar_config google_calendar_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_calendar_config
    ADD CONSTRAINT google_calendar_config_pkey PRIMARY KEY (id);


--
-- Name: inspection_items inspection_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inspection_items
    ADD CONSTRAINT inspection_items_pkey PRIMARY KEY (id);


--
-- Name: invoice_items invoice_items_invoice_id_item_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_items
    ADD CONSTRAINT invoice_items_invoice_id_item_no_key UNIQUE (invoice_id, item_no);


--
-- Name: invoice_items invoice_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_items
    ADD CONSTRAINT invoice_items_pkey PRIMARY KEY (id);


--
-- Name: invoices invoices_document_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_document_id_key UNIQUE (document_id);


--
-- Name: invoices invoices_partnership_id_vendor_invoice_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_partnership_id_vendor_invoice_number_key UNIQUE (partnership_id, vendor, invoice_number);


--
-- Name: invoices invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);


--
-- Name: ledger_documents ledger_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_documents
    ADD CONSTRAINT ledger_documents_pkey PRIMARY KEY (ledger_id, document_id);


--
-- Name: ledger_invoices ledger_invoices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_invoices
    ADD CONSTRAINT ledger_invoices_pkey PRIMARY KEY (ledger_id, invoice_id);


--
-- Name: logbook_documents logbook_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.logbook_documents
    ADD CONSTRAINT logbook_documents_pkey PRIMARY KEY (id);


--
-- Name: logbook_entries logbook_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.logbook_entries
    ADD CONSTRAINT logbook_entries_pkey PRIMARY KEY (id);


--
-- Name: maintenance_attachments maintenance_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_attachments
    ADD CONSTRAINT maintenance_attachments_pkey PRIMARY KEY (id);


--
-- Name: maintenance_intervals maintenance_intervals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_intervals
    ADD CONSTRAINT maintenance_intervals_pkey PRIMARY KEY (id);


--
-- Name: maintenance_items maintenance_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_items
    ADD CONSTRAINT maintenance_items_pkey PRIMARY KEY (id);


--
-- Name: maintenance_log maintenance_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_log
    ADD CONSTRAINT maintenance_log_pkey PRIMARY KEY (id);


--
-- Name: maintenance_recurring maintenance_recurring_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_recurring
    ADD CONSTRAINT maintenance_recurring_pkey PRIMARY KEY (id);


--
-- Name: partnership_members partnership_members_partnership_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partnership_members
    ADD CONSTRAINT partnership_members_partnership_id_user_id_key UNIQUE (partnership_id, user_id);


--
-- Name: partnership_members partnership_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partnership_members
    ADD CONSTRAINT partnership_members_pkey PRIMARY KEY (id);


--
-- Name: partnerships partnerships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partnerships
    ADD CONSTRAINT partnerships_pkey PRIMARY KEY (id);


--
-- Name: password_resets password_resets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_resets
    ADD CONSTRAINT password_resets_pkey PRIMARY KEY (id);


--
-- Name: password_resets password_resets_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_resets
    ADD CONSTRAINT password_resets_token_hash_key UNIQUE (token_hash);


--
-- Name: recurring_charges recurring_charges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_charges
    ADD CONSTRAINT recurring_charges_pkey PRIMARY KEY (id);


--
-- Name: schedule_blocks schedule_blocks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_blocks
    ADD CONSTRAINT schedule_blocks_pkey PRIMARY KEY (id);


--
-- Name: session session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (sid);


--
-- Name: squawks squawks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.squawks
    ADD CONSTRAINT squawks_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: idx_currency_events_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_currency_events_date ON public.currency_events USING btree (event_date);


--
-- Name: idx_currency_events_partnership; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_currency_events_partnership ON public.currency_events USING btree (partnership_id);


--
-- Name: idx_currency_events_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_currency_events_type ON public.currency_events USING btree (event_type);


--
-- Name: idx_currency_events_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_currency_events_user ON public.currency_events USING btree (user_id);


--
-- Name: idx_document_pages_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_pages_document ON public.document_pages USING btree (document_id);


--
-- Name: idx_document_pages_search; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_document_pages_search ON public.document_pages USING gin (search_vector);


--
-- Name: idx_documents_cost_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_cost_category ON public.documents USING btree (cost_category);


--
-- Name: idx_documents_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_expires_at ON public.documents USING btree (expires_at);


--
-- Name: idx_documents_partnership; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_partnership ON public.documents USING btree (partnership_id);


--
-- Name: idx_financial_ledger_auto_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_financial_ledger_auto_key ON public.financial_ledger USING btree (partnership_id, lessee_id, auto_key) WHERE (auto_key IS NOT NULL);


--
-- Name: idx_financial_ledger_effective_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_financial_ledger_effective_date ON public.financial_ledger USING btree (effective_date);


--
-- Name: idx_financial_ledger_partnership; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_financial_ledger_partnership ON public.financial_ledger USING btree (partnership_id);


--
-- Name: idx_flightaware_flights_flight; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_flightaware_flights_flight ON public.flightaware_flights USING btree (flight_id) WHERE (flight_id IS NOT NULL);


--
-- Name: idx_flightaware_flights_off; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_flightaware_flights_off ON public.flightaware_flights USING btree (partnership_id, off_time DESC);


--
-- Name: idx_flights_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_flights_date ON public.flights USING btree (flight_date);


--
-- Name: idx_flights_partnership; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_flights_partnership ON public.flights USING btree (partnership_id);


--
-- Name: idx_flights_pilot; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_flights_pilot ON public.flights USING btree (pilot_id);


--
-- Name: idx_inspection_items_partnership; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inspection_items_partnership ON public.inspection_items USING btree (partnership_id);


--
-- Name: idx_invoice_items_search; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_invoice_items_search ON public.invoice_items USING gin (search_vector);


--
-- Name: idx_ledger_invoices_invoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_invoices_invoice ON public.ledger_invoices USING btree (invoice_id);


--
-- Name: idx_logbook_documents_partnership; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_logbook_documents_partnership ON public.logbook_documents USING btree (partnership_id);


--
-- Name: idx_logbook_entries_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_logbook_entries_category ON public.logbook_entries USING btree (category);


--
-- Name: idx_logbook_entries_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_logbook_entries_date ON public.logbook_entries USING btree (entry_date);


--
-- Name: idx_logbook_entries_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_logbook_entries_document ON public.logbook_entries USING btree (document_id);


--
-- Name: idx_logbook_entries_invoice; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_logbook_entries_invoice ON public.logbook_entries USING btree (invoice_id);


--
-- Name: idx_logbook_entries_partnership; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_logbook_entries_partnership ON public.logbook_entries USING btree (partnership_id);


--
-- Name: idx_logbook_entries_search; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_logbook_entries_search ON public.logbook_entries USING gin (search_vector);


--
-- Name: idx_maint_attach_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maint_attach_parent ON public.maintenance_attachments USING btree (parent_type, parent_id);


--
-- Name: idx_maintenance_intervals_partnership; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maintenance_intervals_partnership ON public.maintenance_intervals USING btree (partnership_id);


--
-- Name: idx_maintenance_items_next_due_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maintenance_items_next_due_date ON public.maintenance_items USING btree (next_due_date);


--
-- Name: idx_maintenance_items_partnership; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_maintenance_items_partnership ON public.maintenance_items USING btree (partnership_id);


--
-- Name: idx_partnership_members_partnership; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_partnership_members_partnership ON public.partnership_members USING btree (partnership_id);


--
-- Name: idx_partnership_members_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_partnership_members_user ON public.partnership_members USING btree (user_id);


--
-- Name: idx_password_resets_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_password_resets_user ON public.password_resets USING btree (user_id, created_at DESC);


--
-- Name: idx_recurring_charges_lessee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recurring_charges_lessee ON public.recurring_charges USING btree (lessee_id);


--
-- Name: idx_recurring_charges_next_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recurring_charges_next_due ON public.recurring_charges USING btree (next_due_date);


--
-- Name: idx_recurring_charges_partnership; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recurring_charges_partnership ON public.recurring_charges USING btree (partnership_id);


--
-- Name: idx_schedule_blocks_partnership; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_schedule_blocks_partnership ON public.schedule_blocks USING btree (partnership_id);


--
-- Name: idx_schedule_blocks_start; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_schedule_blocks_start ON public.schedule_blocks USING btree (start_dt);


--
-- Name: idx_session_expire; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_session_expire ON public.session USING btree (expire);


--
-- Name: idx_squawks_partnership; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_squawks_partnership ON public.squawks USING btree (partnership_id);


--
-- Name: idx_squawks_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_squawks_status ON public.squawks USING btree (status);


--
-- Name: financial_ledger trg_ledger_running_balance; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_ledger_running_balance BEFORE INSERT ON public.financial_ledger FOR EACH ROW EXECUTE FUNCTION public.update_ledger_running_balance();


--
-- Name: currency_events currency_events_partnership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.currency_events
    ADD CONSTRAINT currency_events_partnership_id_fkey FOREIGN KEY (partnership_id) REFERENCES public.partnerships(id) ON DELETE CASCADE;


--
-- Name: currency_events currency_events_related_flight_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.currency_events
    ADD CONSTRAINT currency_events_related_flight_id_fkey FOREIGN KEY (related_flight_id) REFERENCES public.flights(id);


--
-- Name: currency_events currency_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.currency_events
    ADD CONSTRAINT currency_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: document_pages document_pages_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_pages
    ADD CONSTRAINT document_pages_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: document_pages document_pages_partnership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_pages
    ADD CONSTRAINT document_pages_partnership_id_fkey FOREIGN KEY (partnership_id) REFERENCES public.partnerships(id) ON DELETE CASCADE;


--
-- Name: documents documents_partnership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_partnership_id_fkey FOREIGN KEY (partnership_id) REFERENCES public.partnerships(id) ON DELETE CASCADE;


--
-- Name: documents documents_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id);


--
-- Name: financial_ledger financial_ledger_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.financial_ledger
    ADD CONSTRAINT financial_ledger_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: financial_ledger financial_ledger_lessee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.financial_ledger
    ADD CONSTRAINT financial_ledger_lessee_id_fkey FOREIGN KEY (lessee_id) REFERENCES public.users(id);


--
-- Name: financial_ledger financial_ledger_partnership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.financial_ledger
    ADD CONSTRAINT financial_ledger_partnership_id_fkey FOREIGN KEY (partnership_id) REFERENCES public.partnerships(id) ON DELETE CASCADE;


--
-- Name: financial_ledger financial_ledger_related_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.financial_ledger
    ADD CONSTRAINT financial_ledger_related_document_id_fkey FOREIGN KEY (related_document_id) REFERENCES public.documents(id);


--
-- Name: financial_ledger financial_ledger_related_flight_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.financial_ledger
    ADD CONSTRAINT financial_ledger_related_flight_id_fkey FOREIGN KEY (related_flight_id) REFERENCES public.flights(id);


--
-- Name: flights fk_flights_currency_event; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flights
    ADD CONSTRAINT fk_flights_currency_event FOREIGN KEY (currency_event_id) REFERENCES public.currency_events(id);


--
-- Name: flightaware_flights flightaware_flights_flight_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flightaware_flights
    ADD CONSTRAINT flightaware_flights_flight_id_fkey FOREIGN KEY (flight_id) REFERENCES public.flights(id) ON DELETE SET NULL;


--
-- Name: flightaware_flights flightaware_flights_partnership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flightaware_flights
    ADD CONSTRAINT flightaware_flights_partnership_id_fkey FOREIGN KEY (partnership_id) REFERENCES public.partnerships(id) ON DELETE CASCADE;


--
-- Name: flights flights_partnership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flights
    ADD CONSTRAINT flights_partnership_id_fkey FOREIGN KEY (partnership_id) REFERENCES public.partnerships(id) ON DELETE CASCADE;


--
-- Name: flights flights_pilot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flights
    ADD CONSTRAINT flights_pilot_id_fkey FOREIGN KEY (pilot_id) REFERENCES public.users(id);


--
-- Name: google_calendar_config google_calendar_config_connected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_calendar_config
    ADD CONSTRAINT google_calendar_config_connected_by_fkey FOREIGN KEY (connected_by) REFERENCES public.users(id);


--
-- Name: inspection_items inspection_items_partnership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inspection_items
    ADD CONSTRAINT inspection_items_partnership_id_fkey FOREIGN KEY (partnership_id) REFERENCES public.partnerships(id) ON DELETE CASCADE;


--
-- Name: invoice_items invoice_items_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoice_items
    ADD CONSTRAINT invoice_items_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE CASCADE;


--
-- Name: invoices invoices_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: invoices invoices_partnership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invoices
    ADD CONSTRAINT invoices_partnership_id_fkey FOREIGN KEY (partnership_id) REFERENCES public.partnerships(id) ON DELETE CASCADE;


--
-- Name: ledger_documents ledger_documents_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_documents
    ADD CONSTRAINT ledger_documents_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: ledger_documents ledger_documents_ledger_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_documents
    ADD CONSTRAINT ledger_documents_ledger_id_fkey FOREIGN KEY (ledger_id) REFERENCES public.financial_ledger(id) ON DELETE CASCADE;


--
-- Name: ledger_invoices ledger_invoices_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_invoices
    ADD CONSTRAINT ledger_invoices_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE CASCADE;


--
-- Name: ledger_invoices ledger_invoices_ledger_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_invoices
    ADD CONSTRAINT ledger_invoices_ledger_id_fkey FOREIGN KEY (ledger_id) REFERENCES public.financial_ledger(id) ON DELETE CASCADE;


--
-- Name: logbook_documents logbook_documents_partnership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.logbook_documents
    ADD CONSTRAINT logbook_documents_partnership_id_fkey FOREIGN KEY (partnership_id) REFERENCES public.partnerships(id) ON DELETE CASCADE;


--
-- Name: logbook_entries logbook_entries_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.logbook_entries
    ADD CONSTRAINT logbook_entries_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.logbook_documents(id) ON DELETE CASCADE;


--
-- Name: logbook_entries logbook_entries_invoice_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.logbook_entries
    ADD CONSTRAINT logbook_entries_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE SET NULL;


--
-- Name: logbook_entries logbook_entries_partnership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.logbook_entries
    ADD CONSTRAINT logbook_entries_partnership_id_fkey FOREIGN KEY (partnership_id) REFERENCES public.partnerships(id) ON DELETE CASCADE;


--
-- Name: maintenance_attachments maintenance_attachments_partnership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_attachments
    ADD CONSTRAINT maintenance_attachments_partnership_id_fkey FOREIGN KEY (partnership_id) REFERENCES public.partnerships(id) ON DELETE CASCADE;


--
-- Name: maintenance_attachments maintenance_attachments_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_attachments
    ADD CONSTRAINT maintenance_attachments_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id);


--
-- Name: maintenance_intervals maintenance_intervals_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_intervals
    ADD CONSTRAINT maintenance_intervals_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: maintenance_intervals maintenance_intervals_partnership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_intervals
    ADD CONSTRAINT maintenance_intervals_partnership_id_fkey FOREIGN KEY (partnership_id) REFERENCES public.partnerships(id) ON DELETE CASCADE;


--
-- Name: maintenance_items maintenance_items_partnership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_items
    ADD CONSTRAINT maintenance_items_partnership_id_fkey FOREIGN KEY (partnership_id) REFERENCES public.partnerships(id) ON DELETE CASCADE;


--
-- Name: maintenance_log maintenance_log_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_log
    ADD CONSTRAINT maintenance_log_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: maintenance_log maintenance_log_partnership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_log
    ADD CONSTRAINT maintenance_log_partnership_id_fkey FOREIGN KEY (partnership_id) REFERENCES public.partnerships(id) ON DELETE CASCADE;


--
-- Name: maintenance_recurring maintenance_recurring_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_recurring
    ADD CONSTRAINT maintenance_recurring_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: maintenance_recurring maintenance_recurring_partnership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.maintenance_recurring
    ADD CONSTRAINT maintenance_recurring_partnership_id_fkey FOREIGN KEY (partnership_id) REFERENCES public.partnerships(id) ON DELETE CASCADE;


--
-- Name: partnership_members partnership_members_partnership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partnership_members
    ADD CONSTRAINT partnership_members_partnership_id_fkey FOREIGN KEY (partnership_id) REFERENCES public.partnerships(id) ON DELETE CASCADE;


--
-- Name: partnership_members partnership_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partnership_members
    ADD CONSTRAINT partnership_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: password_resets password_resets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_resets
    ADD CONSTRAINT password_resets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: recurring_charges recurring_charges_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_charges
    ADD CONSTRAINT recurring_charges_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: recurring_charges recurring_charges_lessee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_charges
    ADD CONSTRAINT recurring_charges_lessee_id_fkey FOREIGN KEY (lessee_id) REFERENCES public.users(id);


--
-- Name: recurring_charges recurring_charges_partnership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_charges
    ADD CONSTRAINT recurring_charges_partnership_id_fkey FOREIGN KEY (partnership_id) REFERENCES public.partnerships(id) ON DELETE CASCADE;


--
-- Name: schedule_blocks schedule_blocks_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_blocks
    ADD CONSTRAINT schedule_blocks_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: schedule_blocks schedule_blocks_partnership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_blocks
    ADD CONSTRAINT schedule_blocks_partnership_id_fkey FOREIGN KEY (partnership_id) REFERENCES public.partnerships(id) ON DELETE CASCADE;


--
-- Name: schedule_blocks schedule_blocks_pilot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_blocks
    ADD CONSTRAINT schedule_blocks_pilot_id_fkey FOREIGN KEY (pilot_id) REFERENCES public.users(id);


--
-- Name: squawks squawks_partnership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.squawks
    ADD CONSTRAINT squawks_partnership_id_fkey FOREIGN KEY (partnership_id) REFERENCES public.partnerships(id) ON DELETE CASCADE;


--
-- Name: squawks squawks_reported_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.squawks
    ADD CONSTRAINT squawks_reported_by_fkey FOREIGN KEY (reported_by) REFERENCES public.users(id);


--
-- PostgreSQL database dump complete
--


