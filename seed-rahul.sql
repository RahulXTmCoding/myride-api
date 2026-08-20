-- Seed prerequisite: ensure Rahul exists with the UUID the seed-test-data.sql references
INSERT INTO users (id, phone, name, is_verified, is_active, is_onboarding_complete, created_at, updated_at)
VALUES ('63acfd27-beba-46fe-97d7-d52dc2150524', '+919876543210', 'Rahul', true, true, true, NOW(), NOW())
ON CONFLICT (id) DO NOTHING;
