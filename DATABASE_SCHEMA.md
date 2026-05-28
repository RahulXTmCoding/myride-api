# myRide — Database Schema Specification
**Version**: 2.0.0  
**Last Updated**: 2026-05-28  
**Status**: Authoritative — update this file whenever schema changes

---

## Overview of Tables

| # | Table | Purpose |
|---|-------|---------|
| 1 | `user` | Auth, profile, ratings |
| 2 | `vehicle` | User's vehicles (optional) |
| 3 | `trip` | Core trip entity |
| 4 | `trip_member` | Who's in which trip |
| 5 | `trip_stop` | Waypoints/checkpoints |
| 6 | `trip_member_stop` | Per-member stop progress |
| 7 | `location_snapshot` | Periodic GPS history during trip |
| 8 | `community` | Groups/clubs users can create |
| 9 | `community_member` | Who's in which community |
| 10 | `community_invite` | Pending phone-number invites |
| 11 | `chat_message` | Trip chat + community chat |
| 12 | `trip_shareable_link` | Invite link tokens for trips |
| 13 | `payment_transaction` | Offline paid trip records |
| 14 | `sos` | Emergency alerts |
| 15 | `road_side_highlight` | Road hazards/alerts |
| 16 | `speed_data` | Speed tracking during trip |
| 17 | `trip_recommendation` | Suggested trips for users |
| 18 | `accessory` | Product catalog |
| 19 | `review` | Post-trip ratings |
| 20 | `notification` | System notifications |

---

## User Flow Overview

### 1. Auth & Onboarding
```
App Open
  └─► Phone number entry
        └─► OTP sent (dev: console, prod: SMS)
              └─► OTP verified → JWT issued
                    └─► Is profile complete?
                          ├─ NO → Onboarding screen (name required, avatar/vehicle optional)
                          └─ YES → Home screen
```

**Onboarding Rules:**
- `name` is the only required field after OTP login
- `avatar_url`, `bio`, vehicle — all skippable, can be added later
- `is_onboarding_complete` flag on user tracks this

### 2. Community Flow
```
Create Community (name, description, optional photo)
  └─► Add members by phone number → internal notification sent
        └─► Member accepts invite
              └─► Community page visible
                    ├─► Community chat (persistent)
                    └─► Create Trip from community
                          └─► Trip visible only to community members
                                └─► Any member can join the trip
```

### 3. Trip Flow
```
Create Trip (from Home or from Community)
  └─► Set title, start, stops, end, time, vehicle(optional), visibility
        └─► Trip created (status: upcoming)
              └─► Members join (via link, invite, or community browse)
                    └─► Creator starts trip (status: live)
                          └─► Real-time: location WS, chat, stop tracking
                                └─► Trip completed (status: completed)
                                      └─► Reviews + ratings
```

---

## 1️⃣ USER

**Purpose:** Auth, profile, ratings

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | NO | uuid_generate_v4() | PK |
| phone | VARCHAR(20) | NO | — | UNIQUE. Primary login identifier |
| name | VARCHAR(100) | NO | — | Required at onboarding |
| avatar_url | TEXT | YES | NULL | Optional |
| bio | TEXT | YES | NULL | Optional |
| is_onboarding_complete | BOOLEAN | NO | false | true after name saved |
| is_verified | BOOLEAN | NO | false | Phone verified flag |
| average_rating | DECIMAL(3,2) | NO | 0 | 1–5 scale |
| total_ratings_count | INTEGER | NO | 0 | |
| total_trips_created | INTEGER | NO | 0 | |
| total_trips_joined | INTEGER | NO | 0 | |
| account_status | ENUM | NO | 'active' | active / suspended / deleted |
| is_deleted | BOOLEAN | NO | false | Soft delete |
| last_login_at | TIMESTAMP | YES | NULL | |
| created_at | TIMESTAMP | NO | NOW() | |
| updated_at | TIMESTAMP | NO | NOW() | |

**Notes:**
- No `email` or `password_hash` — phone OTP only
- `email` can be added later if notifications require it

**Indexes:**
```sql
CREATE UNIQUE INDEX idx_user_phone ON user(phone);
CREATE INDEX idx_user_is_verified ON user(is_verified);
CREATE INDEX idx_user_account_status ON user(account_status);
```

---

## 2️⃣ VEHICLE

**Purpose:** User's vehicle info — optional, one user can have many

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | NO | uuid_generate_v4() | PK |
| user_id | UUID | NO | — | FK → user.id |
| vehicle_type | ENUM | NO | — | bike / car / auto |
| brand | VARCHAR(100) | YES | NULL | Optional |
| model | VARCHAR(100) | YES | NULL | Optional |
| year | INTEGER | YES | NULL | Optional. CHECK >= 2000 |
| color | VARCHAR(50) | YES | NULL | Optional |
| registration_number | VARCHAR(20) | NO | — | UNIQUE. Required |
| seating_capacity | INTEGER | NO | — | CHECK 1–8 |
| is_active | BOOLEAN | NO | true | Primary vehicle flag |
| created_at | TIMESTAMP | NO | NOW() | |
| updated_at | TIMESTAMP | NO | NOW() | |

**Indexes:**
```sql
CREATE INDEX idx_vehicle_user_id ON vehicle(user_id);
CREATE UNIQUE INDEX idx_vehicle_registration ON vehicle(registration_number);
```

---

## 3️⃣ TRIP

**Purpose:** Core trip entity

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | NO | uuid_generate_v4() | PK |
| created_by_user_id | UUID | NO | — | FK → user.id |
| community_id | UUID | YES | NULL | FK → community.id. NULL = public trip |
| vehicle_id | UUID | YES | NULL | FK → vehicle.id. Optional |
| title | VARCHAR(255) | NO | — | |
| description | TEXT | YES | NULL | |
| start_location_address | VARCHAR(255) | NO | — | |
| start_location_lat | DECIMAL(10,8) | NO | — | |
| start_location_lng | DECIMAL(11,8) | NO | — | |
| end_location_address | VARCHAR(255) | NO | — | |
| end_location_lat | DECIMAL(10,8) | NO | — | |
| end_location_lng | DECIMAL(11,8) | NO | — | |
| start_time | TIMESTAMP | NO | — | |
| estimated_end_time | TIMESTAMP | YES | NULL | |
| status | ENUM | NO | 'upcoming' | upcoming / live / completed / cancelled |
| vehicle_type | ENUM | YES | NULL | bike / car / auto (preference, not required) |
| visibility | ENUM | NO | 'public' | public / private. community trips are effectively private |
| is_paid_trip | BOOLEAN | NO | false | |
| price_per_member | DECIMAL(10,2) | YES | NULL | Only when is_paid_trip = true |
| max_members | INTEGER | NO | — | CHECK 1–50 |
| current_members_count | INTEGER | NO | 1 | Stored counter, updated by app |
| distance_km | DECIMAL(10,2) | YES | NULL | |
| estimated_duration_minutes | INTEGER | YES | NULL | CHECK > 0 |
| is_deleted | BOOLEAN | NO | false | Soft delete |
| created_at | TIMESTAMP | NO | NOW() | |
| updated_at | TIMESTAMP | NO | NOW() | |

**Notes:**
- `community_id` non-null = trip belongs to that community, only members can see it
- `vehicle_id` nullable — vehicle optional for trips
- Paid trips are **offline payments** — `is_paid_trip` just marks it, no gateway integration

**Indexes:**
```sql
CREATE INDEX idx_trip_created_by ON trip(created_by_user_id);
CREATE INDEX idx_trip_community_id ON trip(community_id);
CREATE INDEX idx_trip_status ON trip(status);
CREATE INDEX idx_trip_start_time ON trip(start_time);
CREATE INDEX idx_trip_visibility ON trip(visibility);
```

---

## 4️⃣ TRIP_MEMBER

**Purpose:** Who's in which trip

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | NO | uuid_generate_v4() | PK |
| trip_id | UUID | NO | — | FK → trip.id |
| user_id | UUID | NO | — | FK → user.id |
| role | ENUM | NO | 'member' | creator / member |
| join_status | ENUM | NO | 'joined' | joined / invited / requested / rejected |
| joined_at | TIMESTAMP | NO | NOW() | |
| left_at | TIMESTAMP | YES | NULL | If they left the trip |
| is_active | BOOLEAN | NO | true | Currently in trip |
| rating_given | INTEGER | YES | NULL | Rating 1–5 given to trip creator |
| created_at | TIMESTAMP | NO | NOW() | |
| updated_at | TIMESTAMP | NO | NOW() | |

**Constraints:**
```sql
UNIQUE(trip_id, user_id)
```

**Indexes:**
```sql
CREATE INDEX idx_trip_member_trip_id ON trip_member(trip_id);
CREATE INDEX idx_trip_member_user_id ON trip_member(user_id);
CREATE INDEX idx_trip_member_status ON trip_member(join_status);
```

---

## 5️⃣ TRIP_STOP

**Purpose:** Waypoints/checkpoints in a trip — shared definition (not per-member)

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | NO | uuid_generate_v4() | PK |
| trip_id | UUID | NO | — | FK → trip.id |
| name | VARCHAR(255) | NO | — | |
| stop_type | ENUM | NO | — | start / fuel / food / scenic / return / custom |
| latitude | DECIMAL(10,8) | NO | — | |
| longitude | DECIMAL(11,8) | NO | — | |
| address | VARCHAR(255) | YES | NULL | |
| order | INTEGER | NO | — | CHECK >= 1. Sequence in trip |
| estimated_duration_minutes | INTEGER | YES | 15 | Time to spend here |
| notes | TEXT | YES | NULL | |
| created_at | TIMESTAMP | NO | NOW() | |
| updated_at | TIMESTAMP | NO | NOW() | |

**Note:** No `status` or `completed_at` here — those are per-member and live in `trip_member_stop`.

**Indexes:**
```sql
CREATE INDEX idx_trip_stop_trip_id ON trip_stop(trip_id);
CREATE INDEX idx_trip_stop_order ON trip_stop(trip_id, order);
```

---

## 6️⃣ TRIP_MEMBER_STOP

**Purpose:** Per-member progress at each stop (did THIS user reach THIS stop?)

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | NO | uuid_generate_v4() | PK |
| trip_id | UUID | NO | — | FK → trip.id |
| trip_stop_id | UUID | NO | — | FK → trip_stop.id |
| user_id | UUID | NO | — | FK → user.id |
| status | ENUM | NO | 'pending' | pending / ongoing / completed / skipped |
| arrived_at | TIMESTAMP | YES | NULL | When user reached stop |
| departed_at | TIMESTAMP | YES | NULL | When user left stop |
| created_at | TIMESTAMP | NO | NOW() | |
| updated_at | TIMESTAMP | NO | NOW() | |

**Constraints:**
```sql
UNIQUE(trip_stop_id, user_id)
```

**Indexes:**
```sql
CREATE INDEX idx_tms_trip_id ON trip_member_stop(trip_id);
CREATE INDEX idx_tms_user_id ON trip_member_stop(user_id);
CREATE INDEX idx_tms_stop_id ON trip_member_stop(trip_stop_id);
```

---

## 7️⃣ LOCATION_SNAPSHOT

**Purpose:** Periodic GPS snapshots stored during live trip (real-time via WebSocket, history here)

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | NO | uuid_generate_v4() | PK |
| trip_id | UUID | NO | — | FK → trip.id |
| user_id | UUID | NO | — | FK → user.id |
| latitude | DECIMAL(10,8) | NO | — | |
| longitude | DECIMAL(11,8) | NO | — | |
| accuracy_meters | DECIMAL(6,2) | YES | NULL | GPS accuracy |
| heading | DECIMAL(5,2) | YES | NULL | Direction 0–360° |
| speed_kmh | DECIMAL(6,2) | YES | NULL | Speed at this snapshot |
| recorded_at | TIMESTAMP | NO | — | Client-side time |
| created_at | TIMESTAMP | NO | NOW() | Server-side insert time |

**Notes:**
- Snapshots stored every ~10–30s during live trip
- Retention: 7 days after trip completion, then deleted (privacy)

**Indexes:**
```sql
CREATE INDEX idx_location_trip_id ON location_snapshot(trip_id);
CREATE INDEX idx_location_user_id ON location_snapshot(user_id);
CREATE INDEX idx_location_recorded_at ON location_snapshot(recorded_at);
```

---

## 8️⃣ COMMUNITY

**Purpose:** Persistent groups/clubs — admin-controlled with optional open joining

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | NO | uuid_generate_v4() | PK |
| created_by_user_id | UUID | NO | — | FK → user.id |
| name | VARCHAR(100) | NO | — | UNIQUE per creator? No — global unique name |
| slug | VARCHAR(100) | NO | — | UNIQUE. URL-friendly name |
| description | TEXT | YES | NULL | |
| avatar_url | TEXT | YES | NULL | Community photo |
| join_type | ENUM | NO | 'invite_only' | invite_only / open |
| member_count | INTEGER | NO | 1 | Stored counter |
| is_active | BOOLEAN | NO | true | |
| created_at | TIMESTAMP | NO | NOW() | |
| updated_at | TIMESTAMP | NO | NOW() | |

**Indexes:**
```sql
CREATE UNIQUE INDEX idx_community_slug ON community(slug);
CREATE INDEX idx_community_created_by ON community(created_by_user_id);
```

---

## 9️⃣ COMMUNITY_MEMBER

**Purpose:** Who's in which community

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | NO | uuid_generate_v4() | PK |
| community_id | UUID | NO | — | FK → community.id |
| user_id | UUID | NO | — | FK → user.id |
| role | ENUM | NO | 'member' | admin / member |
| joined_at | TIMESTAMP | NO | NOW() | |
| is_active | BOOLEAN | NO | true | |
| created_at | TIMESTAMP | NO | NOW() | |

**Constraints:**
```sql
UNIQUE(community_id, user_id)
```

**Indexes:**
```sql
CREATE INDEX idx_community_member_community ON community_member(community_id);
CREATE INDEX idx_community_member_user ON community_member(user_id);
```

---

## 🔟 COMMUNITY_INVITE

**Purpose:** Pending invites sent by phone number (before the invitee has the app)

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | NO | uuid_generate_v4() | PK |
| community_id | UUID | NO | — | FK → community.id |
| invited_by_user_id | UUID | NO | — | FK → user.id (admin who invited) |
| phone | VARCHAR(20) | NO | — | Invitee's phone number |
| user_id | UUID | YES | NULL | FK → user.id once they sign up |
| status | ENUM | NO | 'pending' | pending / accepted / rejected / expired |
| invited_at | TIMESTAMP | NO | NOW() | |
| responded_at | TIMESTAMP | YES | NULL | |
| created_at | TIMESTAMP | NO | NOW() | |

**Notes:**
- When a new user signs up with a phone that has a pending invite, auto-link and notify
- Invite is internal (in-app notification only, no SMS in v1)

**Indexes:**
```sql
CREATE INDEX idx_community_invite_community ON community_invite(community_id);
CREATE INDEX idx_community_invite_phone ON community_invite(phone);
CREATE INDEX idx_community_invite_status ON community_invite(status);
```

---

## 1️⃣1️⃣ CHAT_MESSAGE

**Purpose:** Messages in trip chat OR community chat

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | NO | uuid_generate_v4() | PK |
| sender_user_id | UUID | NO | — | FK → user.id |
| chat_type | ENUM | NO | — | trip / community |
| trip_id | UUID | YES | NULL | FK → trip.id. Set if chat_type = trip |
| community_id | UUID | YES | NULL | FK → community.id. Set if chat_type = community |
| message_type | ENUM | NO | 'text' | text / image / location / system |
| content | TEXT | YES | NULL | Text content |
| media_url | TEXT | YES | NULL | Image/file URL |
| is_deleted | BOOLEAN | NO | false | Soft delete |
| created_at | TIMESTAMP | NO | NOW() | |

**Constraints:**
- Either `trip_id` or `community_id` must be set (enforced in app logic)

**Indexes:**
```sql
CREATE INDEX idx_chat_trip_id ON chat_message(trip_id);
CREATE INDEX idx_chat_community_id ON chat_message(community_id);
CREATE INDEX idx_chat_sender ON chat_message(sender_user_id);
CREATE INDEX idx_chat_created_at ON chat_message(created_at);
```

---

## 1️⃣2️⃣ TRIP_SHAREABLE_LINK

**Purpose:** Invite tokens — anyone with link can join a trip

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | NO | uuid_generate_v4() | PK |
| trip_id | UUID | NO | — | FK → trip.id |
| created_by_user_id | UUID | NO | — | FK → user.id |
| token | VARCHAR(64) | NO | — | UNIQUE. Random token |
| max_uses | INTEGER | YES | NULL | NULL = unlimited |
| use_count | INTEGER | NO | 0 | How many times used |
| expires_at | TIMESTAMP | YES | NULL | NULL = never expires |
| is_active | BOOLEAN | NO | true | Can be deactivated |
| created_at | TIMESTAMP | NO | NOW() | |

**Indexes:**
```sql
CREATE UNIQUE INDEX idx_shareable_link_token ON trip_shareable_link(token);
CREATE INDEX idx_shareable_link_trip ON trip_shareable_link(trip_id);
```

---

## 1️⃣3️⃣ PAYMENT_TRANSACTION

**Purpose:** Record of offline payments for paid trips (no gateway in v1)

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | NO | uuid_generate_v4() | PK |
| trip_id | UUID | NO | — | FK → trip.id |
| from_user_id | UUID | NO | — | FK → user.id (payer/member) |
| to_user_id | UUID | NO | — | FK → user.id (trip creator) |
| amount | DECIMAL(10,2) | NO | — | CHECK > 0 |
| currency | VARCHAR(3) | NO | 'INR' | |
| payment_method | ENUM | NO | — | upi / cash / bank_transfer / other |
| transaction_status | ENUM | NO | 'pending' | pending / confirmed / disputed |
| reference_note | VARCHAR(255) | YES | NULL | UPI ref, etc. entered manually |
| transaction_date | TIMESTAMP | NO | NOW() | |
| confirmed_by_creator_at | TIMESTAMP | YES | NULL | When creator marks as received |
| notes | TEXT | YES | NULL | |
| created_at | TIMESTAMP | NO | NOW() | |

**Notes:**
- Offline only in v1. Creator manually confirms receipt.
- `payment_gateway_id` and `gateway_response` removed (no gateway integration)

**Indexes:**
```sql
CREATE INDEX idx_payment_trip ON payment_transaction(trip_id);
CREATE INDEX idx_payment_from_user ON payment_transaction(from_user_id);
CREATE INDEX idx_payment_to_user ON payment_transaction(to_user_id);
CREATE INDEX idx_payment_status ON payment_transaction(transaction_status);
```

---

## 1️⃣4️⃣ SOS

**Purpose:** Emergency alerts during trips — notifies all trip members

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | NO | uuid_generate_v4() | PK |
| trip_id | UUID | NO | — | FK → trip.id |
| triggered_by_user_id | UUID | NO | — | FK → user.id |
| status | ENUM | NO | 'active' | active / resolved / false_alarm |
| latitude | DECIMAL(10,8) | NO | — | |
| longitude | DECIMAL(11,8) | NO | — | |
| address | VARCHAR(255) | YES | NULL | |
| emergency_reason | ENUM | YES | NULL | accident / breakdown / threat / medical / other |
| description | TEXT | YES | NULL | |
| severity_level | ENUM | NO | 'high' | low / medium / high / critical |
| triggered_at | TIMESTAMP | NO | NOW() | |
| resolved_at | TIMESTAMP | YES | NULL | |
| resolved_by_user_id | UUID | YES | NULL | FK → user.id |
| resolution_notes | TEXT | YES | NULL | |
| created_at | TIMESTAMP | NO | NOW() | |

**Notes:**
- On SOS trigger: push notification to all active `trip_member` records
- No external emergency contacts (removed per decision)

**Indexes:**
```sql
CREATE INDEX idx_sos_trip_id ON sos(trip_id);
CREATE INDEX idx_sos_triggered_by ON sos(triggered_by_user_id);
CREATE INDEX idx_sos_status ON sos(status);
```

---

## 1️⃣5️⃣ ROAD_SIDE_HIGHLIGHT

**Purpose:** Crowd-sourced road hazards, closures, events

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | NO | uuid_generate_v4() | PK |
| reported_by_user_id | UUID | YES | NULL | FK → user.id |
| highlight_type | ENUM | NO | — | accident / road_work / protest / weather / maintenance / event |
| latitude | DECIMAL(10,8) | NO | — | |
| longitude | DECIMAL(11,8) | NO | — | |
| address | VARCHAR(255) | NO | — | |
| description | TEXT | NO | — | |
| start_time | TIMESTAMP | NO | — | |
| expected_end_time | TIMESTAMP | YES | NULL | |
| actual_end_time | TIMESTAMP | YES | NULL | |
| is_active | BOOLEAN | NO | true | |
| affected_trips_count | INTEGER | NO | 0 | CHECK >= 0 |
| created_at | TIMESTAMP | NO | NOW() | |
| updated_at | TIMESTAMP | NO | NOW() | |

**Indexes:**
```sql
CREATE INDEX idx_road_highlight_location ON road_side_highlight(latitude, longitude);
CREATE INDEX idx_road_highlight_is_active ON road_side_highlight(is_active);
CREATE INDEX idx_road_highlight_start_time ON road_side_highlight(start_time);
```

---

## 1️⃣6️⃣ SPEED_DATA

**Purpose:** Speed readings during trips (for avg speed, overspeeding detection)

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | NO | uuid_generate_v4() | PK |
| trip_id | UUID | NO | — | FK → trip.id |
| user_id | UUID | NO | — | FK → user.id |
| latitude | DECIMAL(10,8) | NO | — | |
| longitude | DECIMAL(11,8) | NO | — | |
| speed_kmh | DECIMAL(6,2) | NO | — | CHECK 0–300 |
| speed_limit_kmh | INTEGER | YES | NULL | Local limit if known |
| is_speeding | BOOLEAN | NO | false | |
| recorded_at | TIMESTAMP | NO | — | |
| created_at | TIMESTAMP | NO | NOW() | |

**Indexes:**
```sql
CREATE INDEX idx_speed_trip_id ON speed_data(trip_id);
CREATE INDEX idx_speed_user_id ON speed_data(user_id);
CREATE INDEX idx_speed_recorded_at ON speed_data(recorded_at);
```

---

## 1️⃣7️⃣ TRIP_RECOMMENDATION

**Purpose:** Suggested trips shown to users

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | NO | uuid_generate_v4() | PK |
| recommended_trip_id | UUID | NO | — | FK → trip.id |
| recommended_to_user_id | UUID | NO | — | FK → user.id |
| recommendation_reason | ENUM | NO | — | nearby / similar_route / same_vehicle_type / friend_joining / trending / frequent_area |
| relevance_score | DECIMAL(3,2) | NO | — | CHECK 0.00–1.00 |
| is_viewed | BOOLEAN | NO | false | |
| is_joined | BOOLEAN | NO | false | |
| viewed_at | TIMESTAMP | YES | NULL | |
| created_at | TIMESTAMP | NO | NOW() | |

**Indexes:**
```sql
CREATE INDEX idx_trip_rec_trip_id ON trip_recommendation(recommended_trip_id);
CREATE INDEX idx_trip_rec_user_id ON trip_recommendation(recommended_to_user_id);
```

---

## 1️⃣8️⃣ ACCESSORY

**Purpose:** Product catalog (helmets, gear, bike parts, etc.)

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | NO | uuid_generate_v4() | PK |
| name | VARCHAR(255) | NO | — | |
| description | TEXT | YES | NULL | |
| category | ENUM | NO | — | helmet / gloves / jacket / luggage / lights / maintenance / other |
| price | DECIMAL(10,2) | NO | — | CHECK > 0 |
| currency | VARCHAR(3) | NO | 'INR' | |
| image_url | TEXT | YES | NULL | |
| seller_name | VARCHAR(255) | YES | NULL | |
| seller_contact | VARCHAR(255) | YES | NULL | |
| seller_url | TEXT | YES | NULL | |
| is_active | BOOLEAN | NO | true | |
| created_at | TIMESTAMP | NO | NOW() | |
| updated_at | TIMESTAMP | NO | NOW() | |

**Indexes:**
```sql
CREATE INDEX idx_accessory_category ON accessory(category);
CREATE INDEX idx_accessory_is_active ON accessory(is_active);
```

---

## 1️⃣9️⃣ REVIEW

**Purpose:** Post-trip ratings and feedback

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | NO | uuid_generate_v4() | PK |
| trip_id | UUID | NO | — | FK → trip.id |
| reviewer_user_id | UUID | NO | — | FK → user.id |
| reviewee_user_id | UUID | NO | — | FK → user.id |
| rating | INTEGER | NO | — | CHECK 1–5 |
| title | VARCHAR(255) | YES | NULL | |
| comment | TEXT | YES | NULL | |
| tags | TEXT[] | YES | NULL | e.g. friendly, safe, punctual |
| review_type | ENUM | NO | — | driver / member / general |
| helpful_count | INTEGER | NO | 0 | CHECK >= 0 |
| unhelpful_count | INTEGER | NO | 0 | CHECK >= 0 |
| created_at | TIMESTAMP | NO | NOW() | |
| updated_at | TIMESTAMP | NO | NOW() | |

**Constraints:**
```sql
UNIQUE(trip_id, reviewer_user_id, reviewee_user_id)
```

**Indexes:**
```sql
CREATE INDEX idx_review_trip_id ON review(trip_id);
CREATE INDEX idx_review_reviewer ON review(reviewer_user_id);
CREATE INDEX idx_review_reviewee ON review(reviewee_user_id);
```

---

## 2️⃣0️⃣ NOTIFICATION

**Purpose:** In-app notifications for all user events

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | NO | uuid_generate_v4() | PK |
| user_id | UUID | NO | — | FK → user.id (recipient) |
| notification_type | ENUM | NO | — | trip_invitation / member_joined / trip_started / checkpoint_reached / reroute_request / review_received / payment_received / sos_alert / road_alert / community_invite / system_alert |
| title | VARCHAR(255) | NO | — | |
| message | TEXT | NO | — | |
| related_entity_type | ENUM | YES | NULL | Trip / User / Review / Payment / SOS / RoadHighlight / Community |
| related_entity_id | UUID | YES | NULL | |
| action_url | TEXT | YES | NULL | Deep link |
| is_read | BOOLEAN | NO | false | |
| read_at | TIMESTAMP | YES | NULL | |
| is_pushed | BOOLEAN | NO | false | FCM push sent |
| created_at | TIMESTAMP | NO | NOW() | |

**Indexes:**
```sql
CREATE INDEX idx_notification_user_id ON notification(user_id);
CREATE INDEX idx_notification_is_read ON notification(is_read);
CREATE INDEX idx_notification_created_at ON notification(created_at);
```

---

## Key Relationships Summary

```
user ──────────────────► vehicle (1:many, optional)
user ──────────────────► trip (1:many, created_by)
trip ──────────────────► trip_member (1:many)
trip ──────────────────► trip_stop (1:many, ordered)
trip_stop + user ──────► trip_member_stop (progress per member per stop)
trip ──────────────────► location_snapshot (1:many, GPS history)
trip ──────────────────► speed_data (1:many)
trip ──────────────────► chat_message (1:many, type=trip)
trip ──────────────────► trip_shareable_link (1:many)
trip ──────────────────► sos (1:many)
trip ──────────────────► payment_transaction (1:many)
trip ──────────────────► review (1:many)

community ─────────────► community_member (1:many)
community ─────────────► community_invite (1:many, phone-based)
community ─────────────► trip (1:many, community trips)
community ─────────────► chat_message (1:many, type=community)

user ──────────────────► notification (1:many)
user ──────────────────► trip_recommendation (1:many)
```

---

## Changes from Previous Schema (v1 → v2)

| Change | Reason |
|--------|--------|
| Removed `email`, `password_hash` from user | Phone OTP only |
| Added `is_onboarding_complete` to user | Track onboarding state |
| Made `vehicle_id` nullable on trip | Vehicle optional |
| Made `brand`, `model`, `year` nullable on vehicle | Optional fields |
| Removed `status`, `completed_at` from trip_stop | Moved to `trip_member_stop` |
| Added `trip_member_stop` table | Per-member stop progress |
| Added `location_snapshot` table | GPS history storage |
| Added `community` table | New group feature |
| Added `community_member` table | Community membership |
| Added `community_invite` table | Phone-based invites |
| Added `community_id` FK on trip | Community trips |
| Added `chat_type` + `community_id` on chat_message | Supports both trip & community chat |
| Added `trip_shareable_link` table | Invite links |
| Simplified `payment_transaction` | Offline only, removed gateway fields |
| Removed `emergency_contacts_notified` from sos | Not needed |
| Renamed `road_side_highlight` consistently | Clarity |
| Added `community_invite` to notification types | New notification type |
