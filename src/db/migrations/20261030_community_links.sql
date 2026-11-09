CREATE TABLE IF NOT EXISTS public.community_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    platform VARCHAR(50) NOT NULL,
    title VARCHAR(100) NOT NULL,
    description TEXT,
    url TEXT NOT NULL,
    icon_name VARCHAR(50),
    sort_order INT DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.community_links ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'community_links' AND policyname = 'Allow public read access to community links'
  ) THEN
    CREATE POLICY "Allow public read access to community links"
    ON public.community_links FOR SELECT USING (is_active = true);
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'community_links' AND policyname = 'Allow service_role full access to community links'
  ) THEN
    CREATE POLICY "Allow service_role full access to community links"
    ON public.community_links FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

GRANT SELECT ON public.community_links TO anon, authenticated;
GRANT ALL ON public.community_links TO service_role;

-- Seed default community rows if empty
INSERT INTO public.community_links (platform, title, description, url, icon_name, sort_order)
SELECT 'facebook', 'Facebook Community Group', 'Join 40,000+ admission aspirants for live discussions, study groups, and peer problem solving.', 'https://facebook.com/groups/prep404', 'facebook', 1
WHERE NOT EXISTS (SELECT 1 FROM public.community_links WHERE platform = 'facebook');

INSERT INTO public.community_links (platform, title, description, url, icon_name, sort_order)
SELECT 'instagram', 'Instagram', 'Daily exam tips, campus life updates, formula reels, and motivational stories.', 'https://instagram.com/prep404', 'instagram', 2
WHERE NOT EXISTS (SELECT 1 FROM public.community_links WHERE platform = 'instagram');

INSERT INTO public.community_links (platform, title, description, url, icon_name, sort_order)
SELECT 'linkedin', 'LinkedIn Official', 'Follow EdTech insights, university admission trends, career roadmaps, and announcements.', 'https://linkedin.com/company/prep404', 'linkedin', 3
WHERE NOT EXISTS (SELECT 1 FROM public.community_links WHERE platform = 'linkedin');

INSERT INTO public.community_links (platform, title, description, url, icon_name, sort_order)
SELECT 'twitter', 'X (formerly Twitter)', 'Breaking admission circulars, exam schedule updates, and live announcements.', 'https://x.com/prep404', 'twitter', 4
WHERE NOT EXISTS (SELECT 1 FROM public.community_links WHERE platform = 'twitter');

INSERT INTO public.community_links (platform, title, description, url, icon_name, sort_order)
SELECT 'youtube', 'YouTube Channel', 'Video explanations, past year question breakdowns, KaTeX math walkthroughs, and mock test tips.', 'https://youtube.com/@prep404', 'youtube', 5
WHERE NOT EXISTS (SELECT 1 FROM public.community_links WHERE platform = 'youtube');
