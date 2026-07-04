# Azure Deployment Guide — myRide API

> **Region:** `centralindia` throughout.  
> **Resource Group:** `Attars` (shared with Attars app — created resources live here).  
> **Subscription:** `e4f020f0-114e-45c3-baa1-f00c78df849a` (Learning-sub-microsoft)

---

## Resources Created ✅

| Resource | Name | Type | Notes |
|----------|------|------|-------|
| Container Registry | `myrideprod` | ACR Basic | `myrideprod.azurecr.io` |
| PostgreSQL | `myride-db` | Flexible Server B1ms | PostGIS enabled |
| Web App | `myride-api` | Linux container | On shared ASP-Attars-bc47 B1 plan |

## Shared Resources (from Attars app) ♻️

| Resource | Name | Notes |
|----------|------|-------|
| App Service Plan | `ASP-Attars-bc47` | B1 Linux — myride-api deployed here |
| Redis Enterprise | `attars` | `attars.centralindia.redis.azure.net:10000` |
| Storage Account | `attars` | southindia — add new container for myride |
| Front Door CDN | `attars-cdn` | Standard_AzureFrontDoor — add new endpoint |
| Key Vault | `attars-backend-kv` | Store myride secrets here |

---

## Prerequisites

```bash
# Install Azure CLI
# Windows: https://aka.ms/installazurecliwindows

# Log in
az login

# Set subscription
az account set --subscription "e4f020f0-114e-45c3-baa1-f00c78df849a"
```

---

## 1. Resource Providers (one-time)

```bash
az provider register --namespace Microsoft.ContainerRegistry --wait
az provider register --namespace Microsoft.DBforPostgreSQL --wait
```

---

## 2. Azure Container Registry (ACR) ✅ Created

```bash
az acr create \
  --name myrideprod \
  --resource-group Attars \
  --sku Basic \
  --admin-enabled true \
  --location centralindia

# Get credentials (needed as GitHub Secrets)
az acr credential show \
  --name myrideprod \
  --resource-group Attars
# → username: myrideprod, passwords[0].value = ACR_PASSWORD
```

---

## 3. Azure Database for PostgreSQL Flexible Server ✅ Created

~**$15/month** (Burstable B1ms, 32 GB storage).

```bash
az postgres flexible-server create \
  --name myride-db \
  --resource-group Attars \
  --location centralindia \
  --admin-user myrideadmin \
  --admin-password "<STRONG_PASSWORD>" \
  --sku-name Standard_B1ms \
  --tier Burstable \
  --storage-size 32 \
  --version 16 \
  --public-access 0.0.0.0

# Create the application database
az postgres flexible-server db create \
  --server-name myride-db \
  --resource-group Attars \
  --database-name myride
```

**Host:** `myride-db.postgres.database.azure.com:5432`  
**Connection string:** `postgresql://myrideadmin:<PASSWORD>@myride-db.postgres.database.azure.com:5432/myride?sslmode=require`

### Enable PostGIS (run after server is created)

```bash
psql "host=myride-db.postgres.database.azure.com port=5432 dbname=myride user=myrideadmin sslmode=require"
```

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
SELECT PostGIS_Version();
```

> If `CREATE EXTENSION` fails, run:
> ```bash
> az postgres flexible-server parameter set \
>   --name shared_preload_libraries \
>   --value "postgis" \
>   --server-name myride-db \
>   --resource-group Attars
> ```
> Then restart the server and retry.

---

## 4. Redis (Shared — Attars Redis Enterprise) ♻️

No creation needed — reuse existing Redis Enterprise.

**Host:** `attars.centralindia.redis.azure.net`  
**Port:** `10000`  
**Connection string:** `rediss://:<PRIMARY_KEY>@attars.centralindia.redis.azure.net:10000`

```bash
# Get access key
az rest --method POST \
  --uri "https://management.azure.com/subscriptions/e4f020f0-114e-45c3-baa1-f00c78df849a/resourceGroups/Attars/providers/Microsoft.Cache/redisEnterprise/attars/databases/default/listKeys?api-version=2025-04-01" \
  --query primaryKey -o tsv
```

---

## 5. Azure App Service (Web App for Containers) ✅ Created

Deployed on existing `ASP-Attars-bc47` B1 Linux plan (no extra cost).

```bash
# Create Web App (already done)
az webapp create \
  --name myride-api \
  --resource-group Attars \
  --plan ASP-Attars-bc47 \
  --deployment-container-image-name myrideprod.azurecr.io/myride-api:latest

# Configure ACR credentials
az webapp config container set \
  --name myride-api \
  --resource-group Attars \
  --container-image-name myrideprod.azurecr.io/myride-api:latest \
  --container-registry-url https://myrideprod.azurecr.io \
  --container-registry-user myrideprod \
  --container-registry-password "<ACR_PASSWORD>"

# Enable always-on + HTTP/2
az webapp config set \
  --name myride-api \
  --resource-group Attars \
  --always-on true \
  --http20-enabled true \
  --ftps-state Disabled
```

**URL:** `https://myride-api.azurewebsites.net`

---

## 6. App Environment Variables

```bash
az webapp config appsettings set \
  --name myride-api \
  --resource-group Attars \
  --settings \
    NODE_ENV=production \
    PORT=3000 \
    WEBSITES_PORT=3000 \
    JWT_ACCESS_EXPIRATION=15m \
    JWT_REFRESH_EXPIRATION=30d \
    ENABLE_FIREBASE=true \
    FRONTEND_URL="https://your-frontend-domain.com" \
    DATABASE_URL="postgresql://myrideadmin:<PASSWORD>@myride-db.postgres.database.azure.com:5432/myride?sslmode=require" \
    REDIS_URL="rediss://:<PRIMARY_KEY>@attars.centralindia.redis.azure.net:10000" \
    JWT_SECRET="<MIN_32_CHAR_RANDOM_STRING>" \
    FIREBASE_SERVICE_ACCOUNT_PATH="/app/secrets/firebase.json" \
    LIVEKIT_API_KEY="<YOUR_LIVEKIT_API_KEY>" \
    LIVEKIT_API_SECRET="<YOUR_LIVEKIT_API_SECRET>" \
    LIVEKIT_WS_URL="wss://<YOUR_PROJECT>.livekit.cloud"
```

---

## 7. LiveKit — Cloud or Self-Hosted

### Option A — LiveKit Cloud (easiest, ~$0 for low traffic)
1. Sign up at **https://cloud.livekit.io** (free tier: 10,000 mins/month)
2. Create a project → get **API Key**, **API Secret**, **WSS URL**
3. Use `wss://your-project.livekit.cloud` as `LIVEKIT_WS_URL`

### Option B — Self-Hosted on Azure VM (~$14/month, full control)
Required because WebRTC needs UDP ports 50000–50100 which App Service doesn't support.

**→ See [`LIVEKIT_SELF_HOSTED.md`](./LIVEKIT_SELF_HOSTED.md) for the complete step-by-step guide.**

---

## GitHub Secrets to Set

Go to **GitHub → repo → Settings → Secrets and variables → Actions → New repository secret**.

| Secret Name | Value | How to get it |
|---|---|---|
| `AZURE_CREDENTIALS` | Service principal JSON (see below) | `az ad sp create-for-rbac` |
| `AZURE_REGISTRY_LOGIN_SERVER` | `myrideprod.azurecr.io` | Fixed — your ACR login server |
| `AZURE_REGISTRY_USERNAME` | `myrideprod` | From `az acr credential show` |
| `AZURE_REGISTRY_PASSWORD` | `<ACR_PASSWORD_FROM_AZ_ACR_CREDENTIAL_SHOW>` | From `az acr credential show` → `passwords[0].value` |
| `DATABASE_URL` | `postgresql://myrideadmin:<DB_PASSWORD>@myride-db.postgres.database.azure.com:5432/myride?sslmode=require` | PostgreSQL connection string |
| `REDIS_URL` | `rediss://:<REDIS_PRIMARY_KEY>@attars.centralindia.redis.azure.net:10000` | Redis Enterprise — get key from `az rest` command below |
| `JWT_SECRET` | At least 32 random chars | `openssl rand -hex 32` |
| `FRONTEND_URL` | `https://your-frontend-domain.com` | Your frontend URL |
| `LIVEKIT_API_KEY` | Your LiveKit API key | LiveKit Cloud dashboard or self-hosted |
| `LIVEKIT_API_SECRET` | Your LiveKit API secret | LiveKit Cloud dashboard or self-hosted |
| `LIVEKIT_WS_URL` | `wss://your-project.livekit.cloud` | LiveKit Cloud dashboard |
| `LIVEKIT_VM_HOST` | VM public IP | Only if using self-hosted LiveKit |
| `LIVEKIT_VM_USER` | `azureuser` | Only if using self-hosted LiveKit |
| `LIVEKIT_VM_SSH_KEY` | Contents of deploy private key | Only if using self-hosted LiveKit |

### Create the Service Principal for `AZURE_CREDENTIALS` ✅ Created

```bash
MSYS_NO_PATHCONV=1 az ad sp create-for-rbac \
  --name sp-myride-github \
  --role contributor \
  --scopes /subscriptions/e4f020f0-114e-45c3-baa1-f00c78df849a/resourceGroups/Attars \
  --sdk-auth
```

The JSON output looks like:
```json
{
  "clientId": "<SP_CLIENT_ID>",
  "clientSecret": "<SP_CLIENT_SECRET>",
  "subscriptionId": "e4f020f0-114e-45c3-baa1-f00c78df849a",
  "tenantId": "d23fd221-fc80-4331-b14e-487d00d78ba0",
  "activeDirectoryEndpointUrl": "https://login.microsoftonline.com",
  "resourceManagerEndpointUrl": "https://management.azure.com/",
  ...
}
```
Paste this entire JSON as the value for the `AZURE_CREDENTIALS` secret.

---

## GitHub Variables to Set

Go to **GitHub → repo → Settings → Secrets and variables → Actions → Variables tab → New repository variable**.

| Variable Name | Value |
|---|---|
| `AZURE_RESOURCE_GROUP` | `Attars` |
| `AZURE_WEBAPP_NAME` | `myride-api` |
| `AZURE_REGISTRY_LOGIN_SERVER` | `myrideprod.azurecr.io` *(can also be a variable)* |

---

## Estimated Monthly Cost

| Resource | SKU | Est. cost/mo (USD) |
|---|---|---|
| Azure Container Registry | Basic | ~$5 |
| Azure Database for PostgreSQL | Burstable B1ms | ~$15 |
| Azure App Service | Shared B1 plan (already paid) | ~$0 additional |
| Redis Enterprise | Shared (already paid) | ~$0 additional |
| LiveKit Cloud (Option A) | Free tier | $0 (up to 10k mins/mo) |
| **Total new resources** | | **~$20/mo** |
| LiveKit VM: Standard_B1s + Static IP (Option B) | Self-hosted | ~$14/mo |

> The B1 App Service Plan is already paid by the Attars app. myride-api runs as a second app on the same plan at no extra compute cost.

---

## Firewall & Networking Notes

### Web App → PostgreSQL
- PostgreSQL public access rule `AllowAllAzureServicesAndResourcesWithinAzureIps` already set.
- App Service outbound IPs are fixed — for tighter security, add only those:
  ```
  52.140.85.233, 20.235.213.131, 52.140.86.1, 52.140.86.2, 98.70.235.214,
  20.235.214.91, 4.188.90.255, 135.235.234.142, 4.188.93.36, 98.70.234.152
  ```

### Web App → Redis Enterprise
- Redis Enterprise (OSSCluster policy) uses SSL on port 10000.
- URL must use `rediss://` (double-s) prefix with the primary key.

### SSL/TLS
- Azure App Service provides free managed TLS for `*.azurewebsites.net`.
- NestJS TypeORM config has `rejectUnauthorized: false` for production (Azure self-signed Postgres cert).

---

## Custom Domain + SSL

```bash
# 1. Add your domain
az webapp config hostname add \
  --webapp-name myride-api \
  --resource-group Attars \
  --hostname api.yourdomain.com

# 2. Bind a managed certificate (free, auto-renews)
az webapp config ssl bind \
  --name myride-api \
  --resource-group Attars \
  --hostname api.yourdomain.com \
  --ssl-type SNI
```

Add a **CNAME record** in your DNS first:
```
api  →  myride-api.azurewebsites.net
```

---

## Deployment Verification

After the pipeline runs:
```bash
# Check the app is running
curl https://myride-api.azurewebsites.net/

# Stream live logs
az webapp log tail \
  --name myride-api \
  --resource-group Attars

# Check deployment status
az webapp deployment list-publishing-credentials \
  --name myride-api \
  --resource-group Attars

# View current container settings
az webapp config container show \
  --name myride-api \
  --resource-group Attars
```

---

## Quick Reference: All CLI Commands in Order

```bash
# 0. Login
az login
az account set --subscription "e4f020f0-114e-45c3-baa1-f00c78df849a"

# 1. Register providers (one-time)
az provider register --namespace Microsoft.ContainerRegistry --wait
az provider register --namespace Microsoft.DBforPostgreSQL --wait

# 2. ACR ✅ done
az acr create --name myrideprod --resource-group Attars --sku Basic --admin-enabled true --location centralindia

# 3. PostgreSQL ✅ done
az postgres flexible-server create \
  --name myride-db --resource-group Attars --location centralindia \
  --admin-user myrideadmin --admin-password "<PASSWORD>" \
  --sku-name Standard_B1ms --tier Burstable --storage-size 32 --version 16 \
  --public-access 0.0.0.0

az postgres flexible-server db create \
  --server-name myride-db --resource-group Attars --database-name myride

# 4. Enable PostGIS (connect via psql first)
# CREATE EXTENSION IF NOT EXISTS postgis;
# CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

# 5. Web App ✅ done (on existing ASP-Attars-bc47)
az webapp create \
  --name myride-api --resource-group Attars --plan ASP-Attars-bc47 \
  --deployment-container-image-name myrideprod.azurecr.io/myride-api:latest

# 6. Set env vars (after filling in real values)
az webapp config appsettings set --name myride-api --resource-group Attars \
  --settings \
    NODE_ENV=production PORT=3000 WEBSITES_PORT=3000 \
    DATABASE_URL="postgresql://myrideadmin:<PASSWORD>@myride-db.postgres.database.azure.com:5432/myride?sslmode=require" \
    REDIS_URL="rediss://:<REDIS_KEY>@attars.centralindia.redis.azure.net:10000" \
    JWT_SECRET="<MIN_32_CHAR_RANDOM_STRING>" \
    LIVEKIT_API_KEY="..." LIVEKIT_API_SECRET="..." LIVEKIT_WS_URL="wss://..."

# 7. Service principal for GitHub Actions ✅ done
MSYS_NO_PATHCONV=1 az ad sp create-for-rbac --name sp-myride-github --role contributor \
  --scopes /subscriptions/e4f020f0-114e-45c3-baa1-f00c78df849a/resourceGroups/Attars --sdk-auth
```
