-- ============================================================
-- myRide — Full Test Data Seed
-- Run: PGPASSWORD=myride_dev_password psql -h localhost -p 5433 -U myride -d myride -f seed-test-data.sql
--
-- Creates:
--   • 3 extra test users (Priya, Arjun, Dev) with completed onboarding
--   • 3 communities (Himalayan Riders, Ghat Chasers, South Bound)
--   • 6 realistic trips across India with real GPS stops
--     - Manali → Leh (in-progress, bike, paid)
--     - Mumbai → Goa (pending, car, free)
--     - Bangalore → Coorg (pending, bike, paid)
--     - Rishikesh → Chardham Circuit (pending, round-trip, bike)
--     - Pune → Lonavala → Mahabaleshwar (completed, bike)
--     - Delhi → Jaipur (pending, car, free)
--   • Participants wired (Rahul approved on some, pending on others)
--   • Communities linked to trips
-- ============================================================

\set ON_ERROR_STOP on

-- ── User UUIDs ───────────────────────────────────────────────────────────────
-- Rahul (already exists)
\set RAHUL  '63acfd27-beba-46fe-97d7-d52dc2150524'

-- New test users
\set PRIYA  'aaaaaaaa-0001-4000-8000-000000000001'
\set ARJUN  'aaaaaaaa-0001-4000-8000-000000000002'
\set DEV    'aaaaaaaa-0001-4000-8000-000000000003'

-- ── Community UUIDs (existing + new) ─────────────────────────────────────────
-- Weekend Warriors (existing)
\set COMMUNITY_WW   '60ff4d4d-142f-4ba5-9b8a-972419ed1539'
-- Himalayan Riders (new)
\set COMMUNITY_HR   'cccccccc-0001-4000-8000-000000000001'
-- Ghat Chasers (new)
\set COMMUNITY_GC   'cccccccc-0001-4000-8000-000000000002'
-- South Bound (new)
\set COMMUNITY_SB   'cccccccc-0001-4000-8000-000000000003'

-- ── Trip UUIDs ───────────────────────────────────────────────────────────────
\set TRIP_MANALI_LEH         'dddddddd-0001-4000-8000-000000000001'
\set TRIP_MUMBAI_GOA         'dddddddd-0001-4000-8000-000000000002'
\set TRIP_BLR_COORG          'dddddddd-0001-4000-8000-000000000003'
\set TRIP_CHARDHAM           'dddddddd-0001-4000-8000-000000000004'
\set TRIP_PUNE_MAHABAL       'dddddddd-0001-4000-8000-000000000005'
\set TRIP_DELHI_JAIPUR       'dddddddd-0001-4000-8000-000000000006'

-- ============================================================
-- 1. USERS
-- ============================================================

INSERT INTO users (id, phone, name, bio, is_onboarding_complete, preferences, created_at, updated_at)
VALUES
  (:'PRIYA', '+919876500001', 'Priya Sharma',
   'Royal Enfield Classic 350 rider. Loves the mountains. Spiti veteran.',
   true,
   '{"vehicle": {"type": "Royal Enfield Classic 350", "registration": "DL01AB1234"}}',
   NOW() - INTERVAL '30 days', NOW()),

  (:'ARJUN', '+919876500002', 'Arjun Mehta',
   'Weekend warrior on a KTM Duke 390. Ghat roads and chai stops are life.',
   true,
   '{"vehicle": {"type": "KTM Duke 390", "registration": "MH02CD5678"}}',
   NOW() - INTERVAL '25 days', NOW()),

  (:'DEV', '+919876500003', 'Dev Nair',
   'RE Himalayan tourer. Done Leh 3 times. Planning the next one with a crew.',
   true,
   '{"vehicle": {"type": "Royal Enfield Himalayan", "registration": "KA05EF9012"}}',
   NOW() - INTERVAL '20 days', NOW())

ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      bio  = EXCLUDED.bio,
      is_onboarding_complete = true;

-- ============================================================
-- 2. COMMUNITIES
-- ============================================================

INSERT INTO communities (id, name, slug, description, join_type, created_by_user_id, member_count, created_at, updated_at)
VALUES
  (:'COMMUNITY_HR',
   'Himalayan Riders India',
   'himalayan-riders-india',
   'For riders who live to ride high passes. Spiti, Leh, Rohtang and beyond. Annual group expeditions every May and September.',
   'open',
   :'ARJUN',
   0,
   NOW() - INTERVAL '20 days', NOW()),

  (:'COMMUNITY_GC',
   'Ghat Chasers',
   'ghat-chasers',
   'Maharashtra and Karnataka ghat roads — Malshej, Tamhini, Amboli, Coorg. Weekend rides every month.',
   'invite_only',
   :'PRIYA',
   0,
   NOW() - INTERVAL '15 days', NOW()),

  (:'COMMUNITY_SB',
   'South Bound Riders',
   'south-bound-riders',
   'South India road trips — Coorg, Munnar, Ooty, Pondicherry. All vehicle types welcome.',
   'open',
   :'DEV',
   0,
   NOW() - INTERVAL '10 days', NOW())
ON CONFLICT (id) DO NOTHING;

-- Community members
INSERT INTO community_member (id, community_id, user_id, role, is_active, joined_at, created_at)
VALUES
  -- Himalayan Riders: Arjun=admin, Rahul+Dev=member
  (gen_random_uuid(), :'COMMUNITY_HR', :'ARJUN', 'admin',  true, NOW() - INTERVAL '20 days', NOW() - INTERVAL '20 days'),
  (gen_random_uuid(), :'COMMUNITY_HR', :'RAHUL', 'member', true, NOW() - INTERVAL '18 days', NOW() - INTERVAL '18 days'),
  (gen_random_uuid(), :'COMMUNITY_HR', :'DEV',   'member', true, NOW() - INTERVAL '17 days', NOW() - INTERVAL '17 days'),

  -- Ghat Chasers: Priya=admin, Rahul+Arjun=member
  (gen_random_uuid(), :'COMMUNITY_GC', :'PRIYA', 'admin',  true, NOW() - INTERVAL '15 days', NOW() - INTERVAL '15 days'),
  (gen_random_uuid(), :'COMMUNITY_GC', :'RAHUL', 'member', true, NOW() - INTERVAL '13 days', NOW() - INTERVAL '13 days'),
  (gen_random_uuid(), :'COMMUNITY_GC', :'ARJUN', 'member', true, NOW() - INTERVAL '12 days', NOW() - INTERVAL '12 days'),

  -- South Bound: Dev=admin, Priya+Rahul=member
  (gen_random_uuid(), :'COMMUNITY_SB', :'DEV',   'admin',  true, NOW() - INTERVAL '10 days', NOW() - INTERVAL '10 days'),
  (gen_random_uuid(), :'COMMUNITY_SB', :'PRIYA', 'member', true, NOW() - INTERVAL '8 days',  NOW() - INTERVAL '8 days'),
  (gen_random_uuid(), :'COMMUNITY_SB', :'RAHUL', 'member', true, NOW() - INTERVAL '7 days',  NOW() - INTERVAL '7 days')
ON CONFLICT DO NOTHING;

-- Update member counts
UPDATE communities SET member_count = 3 WHERE id IN (:'COMMUNITY_HR', :'COMMUNITY_GC', :'COMMUNITY_SB');
UPDATE communities SET member_count = member_count + 1 WHERE id = :'COMMUNITY_WW';

-- ============================================================
-- 3. TRIPS
-- ============================================================

-- ── TRIP 1: Manali → Leh (IN-PROGRESS, bike, paid) ─────────────────────────
-- Creator: Arjun | Community: Himalayan Riders
INSERT INTO trips (id, title, description, trip_type, visibility, is_paid, trip_price,
                   status, creator_id, max_participants, current_participants,
                   scheduled_start_time, actual_start_time, metadata, community_id, created_at, updated_at)
VALUES (
  :'TRIP_MANALI_LEH',
  'Manali to Leh — Monsoon Edition 2026',
  'The classic Himalayan highway. We leave at dawn from Old Manali, cross Rohtang, camp at Jispa, push through Baralacha La and Tanglang La to reach Leh on day 3. BRO-maintained roads. Carry warm layers and full tank from Tandi — no fuel till Pang.',
  'one-way', 'public', true, 1800,
  'in-progress',
  :'ARJUN',
  8, 3,
  NOW() - INTERVAL '1 day',
  NOW() - INTERVAL '6 hours',
  '{"vehicle_type": "bike", "difficulty": "hard", "tags": ["himalaya", "high-altitude", "adventure"]}',
  :'COMMUNITY_HR',
  NOW() - INTERVAL '10 days', NOW()
) ON CONFLICT (id) DO NOTHING;

INSERT INTO trip_stops (id, trip_id, stop_order, name, description, location, address, stop_type, duration_minutes, is_mandatory, created_at, updated_at) VALUES
  (gen_random_uuid(), :'TRIP_MANALI_LEH', 1, 'Old Manali', 'Start point. Assemble at the bridge by 5am. Fuel up here.', ST_GeographyFromText('POINT(77.1892 32.2396)'), 'Old Manali Bridge, Manali, HP 175131', 'start', 30, true, NOW(), NOW()),
  (gen_random_uuid(), :'TRIP_MANALI_LEH', 2, 'Rohtang Pass', 'First major pass at 3,978m. Photo stop + altitude check. BRO checkpoint here.', ST_GeographyFromText('POINT(77.2434 32.3715)'), 'Rohtang Pass, Kullu District, HP', 'waypoint', 45, true, NOW(), NOW()),
  (gen_random_uuid(), :'TRIP_MANALI_LEH', 3, 'Tandi Fuel Stop', 'Last reliable petrol pump before Leh. Fill full tank. No exceptions.', ST_GeographyFromText('POINT(77.0061 32.5433)'), 'HPCL Petrol Pump, Tandi, HP', 'fuel', 20, true, NOW(), NOW()),
  (gen_random_uuid(), :'TRIP_MANALI_LEH', 4, 'Jispa Camp', 'Night 1 — riverside tented camp. Dal and rice dinner included.', ST_GeographyFromText('POINT(77.0294 32.6680)'), 'Jispa, Lahaul, HP 175142', 'rest', 480, true, NOW(), NOW()),
  (gen_random_uuid(), :'TRIP_MANALI_LEH', 5, 'Baralacha La', 'Second pass at 4,890m. Challenging switchbacks. Keep close.', ST_GeographyFromText('POINT(77.3836 32.9792)'), 'Baralacha La, Lahaul-Spiti, HP', 'waypoint', 30, true, NOW(), NOW()),
  (gen_random_uuid(), :'TRIP_MANALI_LEH', 6, 'Sarchu Lunch', 'High-altitude plains lunch stop at 4,253m. Quick hot noodles.', ST_GeographyFromText('POINT(77.6476 33.0735)'), 'Sarchu, J&K / HP Border', 'food', 40, false, NOW(), NOW()),
  (gen_random_uuid(), :'TRIP_MANALI_LEH', 7, 'Tanglang La', 'Highest pass on route — 5,328m. Acclimatization critical. Short stop.', ST_GeographyFromText('POINT(77.6506 33.4759)'), 'Tanglang La, Ladakh', 'waypoint', 15, true, NOW(), NOW()),
  (gen_random_uuid(), :'TRIP_MANALI_LEH', 8, 'Leh City', 'Destination! Check-in at hotel, rest, celebrate over momos and cold beer.', ST_GeographyFromText('POINT(77.5771 34.1526)'), 'Main Bazaar, Leh, Ladakh 194101', 'destination', 60, true, NOW(), NOW())
ON CONFLICT DO NOTHING;

-- ── TRIP 2: Mumbai → Goa (PENDING, car, free) ────────────────────────────────
-- Creator: Priya | Community: Ghat Chasers
INSERT INTO trips (id, title, description, trip_type, visibility, is_paid, trip_price,
                   status, creator_id, max_participants, current_participants,
                   scheduled_start_time, metadata, community_id, created_at, updated_at)
VALUES (
  :'TRIP_MUMBAI_GOA',
  'Mumbai → Goa Coastal Cruise',
  'NH66 coastal highway — flat, fast and scenic. We stop at Kashid beach, grab seafood at Chiplun and overnight at Ratnagiri before the final push to Panjim. Mix of highway and old coastal road. All vehicles welcome.',
  'one-way', 'public', false, NULL,
  'pending',
  :'PRIYA',
  6, 2,
  NOW() + INTERVAL '5 days',
  '{"vehicle_type": "car", "difficulty": "easy", "tags": ["coastal", "highway", "goa", "beach"]}',
  :'COMMUNITY_GC',
  NOW() - INTERVAL '3 days', NOW()
) ON CONFLICT (id) DO NOTHING;

INSERT INTO trip_stops (id, trip_id, stop_order, name, description, location, address, stop_type, duration_minutes, is_mandatory, created_at, updated_at) VALUES
  (gen_random_uuid(), :'TRIP_MUMBAI_GOA', 1, 'Worli Sea Face', 'Assembly point. Parking near Worli fort. Leave by 6am to beat Mumbai traffic.', ST_GeographyFromText('POINT(72.8178 19.0082)'), 'Worli Sea Face, Mumbai, MH 400030', 'start', 20, true, NOW(), NOW()),
  (gen_random_uuid(), :'TRIP_MUMBAI_GOA', 2, 'Kashid Beach', 'White sand beach, 120km from Mumbai. Quick dip and chai. 2hr drive.', ST_GeographyFromText('POINT(72.9149 18.4038)'), 'Kashid Beach, Alibag, MH 402401', 'waypoint', 60, false, NOW(), NOW()),
  (gen_random_uuid(), :'TRIP_MUMBAI_GOA', 3, 'Hotel Abhishek, Chiplun', 'Lunch — famous mutton thali and fresh pomfret. Do NOT skip this.', ST_GeographyFromText('POINT(73.5283 17.5313)'), 'Chiplun, Ratnagiri District, MH', 'food', 60, true, NOW(), NOW()),
  (gen_random_uuid(), :'TRIP_MUMBAI_GOA', 4, 'Ratnagiri — Night Stay', 'Overnight stay. Ganpatipule nearby for sunrise if anyone is keen.', ST_GeographyFromText('POINT(73.2985 16.9944)'), 'Ratnagiri, Maharashtra 415612', 'rest', 600, true, NOW(), NOW()),
  (gen_random_uuid(), :'TRIP_MUMBAI_GOA', 5, 'Amboli Ghat Viewpoint', 'Misty Western Ghats pass. Morning fog makes this surreal in July.', ST_GeographyFromText('POINT(74.0014 15.9565)'), 'Amboli, Sindhudurg, MH 416510', 'waypoint', 30, false, NOW(), NOW()),
  (gen_random_uuid(), :'TRIP_MUMBAI_GOA', 6, 'Panjim, Goa', 'Final destination. Check in, Mandovi river walk, sunset cruise tonight.', ST_GeographyFromText('POINT(73.8278 15.4909)'), 'Panjim (Panaji), North Goa, GA 403001', 'destination', 0, true, NOW(), NOW())
ON CONFLICT DO NOTHING;

-- ── TRIP 3: Bangalore → Coorg (PENDING, bike, paid) ─────────────────────────
-- Creator: Dev | Community: South Bound
INSERT INTO trips (id, title, description, trip_type, visibility, is_paid, trip_price,
                   status, creator_id, max_participants, current_participants,
                   scheduled_start_time, metadata, community_id, created_at, updated_at)
VALUES (
  :'TRIP_BLR_COORG',
  'Bangalore to Coorg — Coffee & Curves',
  'Misty mornings, elephant corridors and the best filter coffee in Karnataka. We ride through Mysore and enter Coorg on the scenic Madikeri road. Homestay arranged at an organic coffee estate.',
  'one-way', 'public', true, 999,
  'pending',
  :'DEV',
  5, 1,
  NOW() + INTERVAL '7 days',
  '{"vehicle_type": "bike", "difficulty": "moderate", "tags": ["coorg", "coffee", "curves", "south"]}',
  :'COMMUNITY_SB',
  NOW() - INTERVAL '2 days', NOW()
) ON CONFLICT (id) DO NOTHING;

INSERT INTO trip_stops (id, trip_id, stop_order, name, description, location, address, stop_type, duration_minutes, is_mandatory, created_at, updated_at) VALUES
  (gen_random_uuid(), :'TRIP_BLR_COORG', 1, 'Silk Board, Bangalore', 'Start — 6am assembly. Ride down Hosur Road to avoid city traffic.', ST_GeographyFromText('POINT(77.6230 12.9172)'), 'Silk Board Junction, Bangalore, KA 560068', 'start', 15, true, NOW(), NOW()),
  (gen_random_uuid(), :'TRIP_BLR_COORG', 2, 'Kamat Upachar, Bidadi', 'Idli-vada breakfast. Legendary Karnataka-style masala dosa here.', ST_GeographyFromText('POINT(77.3937 12.7940)'), 'Kamat Upachar, Bidadi, KA 562109', 'food', 45, true, NOW(), NOW()),
  (gen_random_uuid(), :'TRIP_BLR_COORG', 3, 'Mysore Palace', 'Quick photo stop. Palace looks incredible in the morning light.', ST_GeographyFromText('POINT(76.6551 12.3052)'), 'Mysore Palace, Mysuru, KA 570001', 'waypoint', 30, false, NOW(), NOW()),
  (gen_random_uuid(), :'TRIP_BLR_COORG', 4, 'Kushalnagar Fuel + Chai', 'Fuel up before the Coorg ghats. Last proper petrol station.', ST_GeographyFromText('POINT(75.9685 12.4639)'), 'Kushalnagar, Kodagu, KA 571234', 'fuel', 20, true, NOW(), NOW()),
  (gen_random_uuid(), :'TRIP_BLR_COORG', 5, 'Raja Seat, Madikeri', 'Sunset viewpoint over the Coorg valley. Arrive by 5pm for golden hour.', ST_GeographyFromText('POINT(75.7379 12.4244)'), 'Raja Seat, Madikeri, Kodagu, KA 571201', 'waypoint', 45, false, NOW(), NOW()),
  (gen_random_uuid(), :'TRIP_BLR_COORG', 6, 'Honey Valley Estate', 'Coffee estate homestay — dinner, estate walk, birdwatching at dawn.', ST_GeographyFromText('POINT(75.8189 12.3503)'), 'Honey Valley Estate, Kodagu, KA 571218', 'destination', 0, true, NOW(), NOW())
ON CONFLICT DO NOTHING;

-- ── TRIP 4: Rishikesh → Chardham Circuit (PENDING, round-trip, bike) ──────
-- Creator: Rahul | Community: Himalayan Riders
INSERT INTO trips (id, title, description, trip_type, visibility, is_paid, trip_price,
                   status, creator_id, max_participants, current_participants,
                   scheduled_start_time, metadata, community_id, created_at, updated_at)
VALUES (
  :'TRIP_CHARDHAM',
  'Chardham Yatra 2026 — Biker Edition',
  '12-day circuit covering all four Dhams: Yamunotri, Gangotri, Kedarnath (base), and Badrinath. Pure spiritual and riding experience. No shortcuts — we ride all of it. Support vehicle for luggage arranged.',
  'round-trip', 'public', true, 4500,
  'pending',
  :'RAHUL',
  10, 1,
  NOW() + INTERVAL '21 days',
  '{"vehicle_type": "bike", "difficulty": "hard", "tags": ["chardham", "spiritual", "himalaya", "12-day"]}',
  :'COMMUNITY_HR',
  NOW() - INTERVAL '5 days', NOW()
) ON CONFLICT (id) DO NOTHING;

INSERT INTO trip_stops (id, trip_id, stop_order, name, description, location, address, stop_type, duration_minutes, is_mandatory, created_at, updated_at) VALUES
  (gen_random_uuid(), :'TRIP_CHARDHAM', 1, 'Rishikesh — Laxman Jhula', 'Base camp and start. Evening aarti at Triveni Ghat the night before departure.', ST_GeographyFromText('POINT(78.3273 30.1270)'), 'Laxman Jhula, Rishikesh, UK 249302', 'start', 60, true, NOW(), NOW()),
  (gen_random_uuid(), :'TRIP_CHARDHAM', 2, 'Barkot (Yamunotri base)', 'Day 2. Gateway to Yamunotri. Bikes parked here, trek to dham.', ST_GeographyFromText('POINT(78.2060 30.8043)'), 'Barkot, Uttarkashi, UK 249141', 'waypoint', 480, true, NOW(), NOW()),
  (gen_random_uuid(), :'TRIP_CHARDHAM', 3, 'Uttarkashi — Night Stay', 'Day 3. Holy town on Bhagirathi. Famous Vishwanath temple visit.', ST_GeographyFromText('POINT(78.4467 30.7268)'), 'Uttarkashi, Uttarakhand 249193', 'rest', 600, true, NOW(), NOW()),
  (gen_random_uuid(), :'TRIP_CHARDHAM', 4, 'Gangotri', 'Day 4. Source of Ganga. 3,100m — cold. Ride the jaw-dropping gorge road.', ST_GeographyFromText('POINT(78.9389 30.9939)'), 'Gangotri, Uttarkashi, UK 249193', 'waypoint', 240, true, NOW(), NOW()),
  (gen_random_uuid(), :'TRIP_CHARDHAM', 5, 'Guptkashi (Kedarnath base)', 'Day 7. Park bikes. Take ponies or heli to Kedarnath shrine at 3,583m.', ST_GeographyFromText('POINT(79.0779 30.5250)'), 'Guptkashi, Rudraprayag, UK 246439', 'waypoint', 960, true, NOW(), NOW()),
  (gen_random_uuid(), :'TRIP_CHARDHAM', 6, 'Badrinath', 'Day 10. Final dham — Vishnu temple at 3,133m. Mana village (last Indian village) 3km ahead.', ST_GeographyFromText('POINT(79.4937 30.7433)'), 'Badrinath, Chamoli, UK 246422', 'waypoint', 240, true, NOW(), NOW()),
  (gen_random_uuid(), :'TRIP_CHARDHAM', 7, 'Rishikesh — Return', 'Day 12. Ride back via Devprayag. Circuit complete.', ST_GeographyFromText('POINT(78.3273 30.1270)'), 'Laxman Jhula, Rishikesh, UK 249302', 'destination', 0, true, NOW(), NOW())
ON CONFLICT DO NOTHING;

-- ── TRIP 5: Pune → Mahabaleshwar (COMPLETED) ─────────────────────────────────
-- Creator: Arjun
INSERT INTO trips (id, title, description, trip_type, visibility, is_paid, trip_price,
                   status, creator_id, max_participants, current_participants,
                   scheduled_start_time, actual_start_time, actual_end_time, metadata, created_at, updated_at)
VALUES (
  :'TRIP_PUNE_MAHABAL',
  'Pune Ghat Blast — Lonavala & Mahabaleshwar',
  'Classic Western Ghats day-tripper. Khandala sunrise, Bhushi Dam (if rains allow), Venna Lake and strawberry jam shopping. Home by evening.',
  'one-way', 'public', false, NULL,
  'completed',
  :'ARJUN',
  6, 4,
  NOW() - INTERVAL '14 days',
  NOW() - INTERVAL '14 days',
  NOW() - INTERVAL '13 days',
  '{"vehicle_type": "bike", "difficulty": "easy", "tags": ["ghats", "daytrip", "pune", "weekend"]}',
  NOW() - INTERVAL '20 days', NOW()
) ON CONFLICT (id) DO NOTHING;

INSERT INTO trip_stops (id, trip_id, stop_order, name, description, location, address, stop_type, duration_minutes, is_mandatory, created_at, updated_at) VALUES
  (gen_random_uuid(), :'TRIP_PUNE_MAHABAL', 1, 'Katraj, Pune', 'Assemble at Katraj toll. Depart 5:30am to catch sunrise on the ghats.', ST_GeographyFromText('POINT(73.8677 18.4550)'), 'Katraj Toll Naka, Pune, MH 411046', 'start', 10, true, NOW(), NOW()),
  (gen_random_uuid(), :'TRIP_PUNE_MAHABAL', 2, 'Khandala Sunrise Point', 'Duke''s Nose viewpoint. Clouds and valley fog make this magical in monsoon.', ST_GeographyFromText('POINT(73.3750 18.7553)'), 'Khandala, Pune District, MH 410301', 'waypoint', 45, true, NOW(), NOW()),
  (gen_random_uuid(), :'TRIP_PUNE_MAHABAL', 3, 'Lonavala Chikki', 'Iconic Lonavala fudge stop. Cooper''s Chikki is non-negotiable.', ST_GeographyFromText('POINT(73.4046 18.7481)'), 'Cooper''s Chikki, Lonavala, MH 410401', 'food', 30, false, NOW(), NOW()),
  (gen_random_uuid(), :'TRIP_PUNE_MAHABAL', 4, 'Bhushi Dam', 'Dam overflow — ride through the water sheet (if safe). Absolute madness.', ST_GeographyFromText('POINT(73.3991 18.7344)'), 'Bhushi Dam, Lonavala, MH 410401', 'waypoint', 45, false, NOW(), NOW()),
  (gen_random_uuid(), :'TRIP_PUNE_MAHABAL', 5, 'Venna Lake, Mahabaleshwar', 'Boating + corn bhutta by the lake. Strawberry farms at the market.', ST_GeographyFromText('POINT(73.6581 17.9273)'), 'Venna Lake, Mahabaleshwar, MH 412806', 'waypoint', 90, true, NOW(), NOW()),
  (gen_random_uuid(), :'TRIP_PUNE_MAHABAL', 6, 'Arthur''s Seat Viewpoint', 'The Queen of Points — 1,400m drop into the valley. Sunset target.', ST_GeographyFromText('POINT(73.6381 17.9397)'), 'Arthur''s Seat, Mahabaleshwar, MH 412806', 'destination', 30, true, NOW(), NOW())
ON CONFLICT DO NOTHING;

-- ── TRIP 6: Delhi → Jaipur (PENDING, car, free) ──────────────────────────────
-- Creator: Dev
INSERT INTO trips (id, title, description, trip_type, visibility, is_paid, trip_price,
                   status, creator_id, max_participants, current_participants,
                   scheduled_start_time, metadata, created_at, updated_at)
VALUES (
  :'TRIP_DELHI_JAIPUR',
  'Delhi → Jaipur — Pink City Weekend',
  'NH48 Express Highway to Jaipur. Drive is under 4hrs. Amber Fort, Hawa Mahal, City Palace and the best laal maas in Rajasthan. Back Sunday evening.',
  'round-trip', 'public', false, NULL,
  'pending',
  :'DEV',
  4, 1,
  NOW() + INTERVAL '3 days',
  '{"vehicle_type": "car", "difficulty": "easy", "tags": ["rajasthan", "weekend", "heritage", "jaipur"]}',
  NOW() - INTERVAL '1 day', NOW()
) ON CONFLICT (id) DO NOTHING;

INSERT INTO trip_stops (id, trip_id, stop_order, name, description, location, address, stop_type, duration_minutes, is_mandatory, created_at, updated_at) VALUES
  (gen_random_uuid(), :'TRIP_DELHI_JAIPUR', 1, 'DLF Cyber Hub, Gurugram', 'Start — meet at the open-air plaza. Leave by 7am on NH48.', ST_GeographyFromText('POINT(77.0929 28.4969)'), 'DLF Cyber Hub, Gurugram, HR 122002', 'start', 10, true, NOW(), NOW()),
  (gen_random_uuid(), :'TRIP_DELHI_JAIPUR', 2, 'Neemrana Fort Cafe', 'Pit stop midway — chai and paratha. Neemrana stepwell optional 15min visit.', ST_GeographyFromText('POINT(76.3822 27.9757)'), 'Neemrana, Alwar, RJ 301705', 'food', 30, false, NOW(), NOW()),
  (gen_random_uuid(), :'TRIP_DELHI_JAIPUR', 3, 'Amber Fort', 'First stop in Jaipur. Elephant ride or jeep up to the fort. 2hr visit.', ST_GeographyFromText('POINT(75.8513 26.9855)'), 'Amber Fort, Amer, Jaipur, RJ 302028', 'waypoint', 120, true, NOW(), NOW()),
  (gen_random_uuid(), :'TRIP_DELHI_JAIPUR', 4, 'Hawa Mahal & Johari Bazaar', 'Classic old city walk — Hawa Mahal photo, Johari Bazaar for silver jewellery.', ST_GeographyFromText('POINT(75.8267 26.9239)'), 'Hawa Mahal, Old City, Jaipur, RJ 302002', 'waypoint', 90, false, NOW(), NOW()),
  (gen_random_uuid(), :'TRIP_DELHI_JAIPUR', 5, 'Hotel Diggi Palace', 'Heritage hotel stay. Dinner — Rajasthani thali with dal baati churma.', ST_GeographyFromText('POINT(75.8127 26.9124)'), 'Diggi Palace, Jaipur, RJ 302001', 'rest', 720, true, NOW(), NOW()),
  (gen_random_uuid(), :'TRIP_DELHI_JAIPUR', 6, 'DLF Cyber Hub, Gurugram', 'Return to Gurugram. NH48 back. Target reach by 8pm Sunday.', ST_GeographyFromText('POINT(77.0929 28.4969)'), 'DLF Cyber Hub, Gurugram, HR 122002', 'destination', 0, true, NOW(), NOW())
ON CONFLICT DO NOTHING;

-- ============================================================
-- 4. TRIP PARTICIPANTS
-- ============================================================
-- Manali→Leh (in-progress): Arjun=creator+admin, Rahul=approved, Dev=approved
INSERT INTO trip_participants (id, trip_id, user_id, role, status, created_at) VALUES
  (gen_random_uuid(), :'TRIP_MANALI_LEH', :'ARJUN', 'admin',  'approved', NOW() - INTERVAL '10 days'),
  (gen_random_uuid(), :'TRIP_MANALI_LEH', :'RAHUL', 'member', 'approved', NOW() - INTERVAL '9 days'),
  (gen_random_uuid(), :'TRIP_MANALI_LEH', :'DEV',   'member', 'approved', NOW() - INTERVAL '9 days')
ON CONFLICT DO NOTHING;

-- Mumbai→Goa (pending): Priya=creator, Rahul=approved, Arjun=PENDING
INSERT INTO trip_participants (id, trip_id, user_id, role, status, created_at) VALUES
  (gen_random_uuid(), :'TRIP_MUMBAI_GOA', :'PRIYA', 'admin',  'approved', NOW() - INTERVAL '3 days'),
  (gen_random_uuid(), :'TRIP_MUMBAI_GOA', :'RAHUL', 'member', 'approved', NOW() - INTERVAL '2 days'),
  (gen_random_uuid(), :'TRIP_MUMBAI_GOA', :'ARJUN', 'member', 'pending',  NOW() - INTERVAL '1 day')
ON CONFLICT DO NOTHING;
UPDATE trips SET current_participants = 2 WHERE id = :'TRIP_MUMBAI_GOA';

-- Bangalore→Coorg (pending): Dev=creator, Rahul=PENDING
INSERT INTO trip_participants (id, trip_id, user_id, role, status, created_at) VALUES
  (gen_random_uuid(), :'TRIP_BLR_COORG', :'DEV',   'admin',  'approved', NOW() - INTERVAL '2 days'),
  (gen_random_uuid(), :'TRIP_BLR_COORG', :'RAHUL', 'member', 'pending',  NOW() - INTERVAL '1 day')
ON CONFLICT DO NOTHING;

-- Chardham (pending): Rahul=creator — no other participants yet (open to join)
INSERT INTO trip_participants (id, trip_id, user_id, role, status, created_at) VALUES
  (gen_random_uuid(), :'TRIP_CHARDHAM', :'RAHUL', 'admin', 'approved', NOW() - INTERVAL '5 days')
ON CONFLICT DO NOTHING;

-- Pune→Mahabal (completed): Arjun=creator, Rahul+Priya+Dev=approved
INSERT INTO trip_participants (id, trip_id, user_id, role, status, created_at) VALUES
  (gen_random_uuid(), :'TRIP_PUNE_MAHABAL', :'ARJUN', 'admin',  'approved', NOW() - INTERVAL '20 days'),
  (gen_random_uuid(), :'TRIP_PUNE_MAHABAL', :'RAHUL', 'member', 'approved', NOW() - INTERVAL '19 days'),
  (gen_random_uuid(), :'TRIP_PUNE_MAHABAL', :'PRIYA', 'member', 'approved', NOW() - INTERVAL '19 days'),
  (gen_random_uuid(), :'TRIP_PUNE_MAHABAL', :'DEV',   'member', 'approved', NOW() - INTERVAL '18 days')
ON CONFLICT DO NOTHING;

-- Delhi→Jaipur (pending): Dev=creator — open to join
INSERT INTO trip_participants (id, trip_id, user_id, role, status, created_at) VALUES
  (gen_random_uuid(), :'TRIP_DELHI_JAIPUR', :'DEV', 'admin', 'approved', NOW() - INTERVAL '1 day')
ON CONFLICT DO NOTHING;

-- ============================================================
-- 5. COMPLETE ONBOARDING FOR RAHUL
-- ============================================================
UPDATE users
SET is_onboarding_complete = true,
    name = COALESCE(NULLIF(name, ''), 'Rahul Singh'),
    bio  = COALESCE(NULLIF(bio::text, '')::text, 'Riding the mountains since forever. Leh done. Spiti done. Next: Chardham.')
WHERE id = :'RAHUL';

-- ============================================================
-- SUMMARY
-- ============================================================
SELECT '=== SEED COMPLETE ===' AS status;
SELECT 'Users' AS entity, COUNT(*) AS total FROM users;
SELECT 'Communities' AS entity, COUNT(*) AS total FROM communities;
SELECT 'Community Members' AS entity, COUNT(*) AS total FROM community_member;
SELECT 'Trips' AS entity, COUNT(*) AS total FROM trips;
SELECT 'Trip Stops' AS entity, COUNT(*) AS total FROM trip_stops;
SELECT 'Trip Participants' AS entity, COUNT(*) AS total FROM trip_participants;
SELECT title, status, current_participants || '/' || max_participants AS seats FROM trips ORDER BY created_at;
