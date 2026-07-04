# Azure Deployment Guide — myRide API

> **Region:** `centralindia` is used throughout (good latency for India-based users).  
> Swap to `eastus` if you need cheaper/more available SKUs.

---

## Prerequisites

```bash
# Install Azure CLI (if not already installed)
# Windows: https://aka.ms/installazurecliwindows
# macOS:
brew install azure-cli

# Log in
az login

# Confirm subscription
az account show
az account set --subscription "<YOUR_SUBSCRIPTION_ID>"  # if you have multiple
```

---

## 1. Resource Group

```bash
az group create \
  --name rg-myride-prod \
  --location centralindia
```

---

## 2. Azure Container Registry (ACR)

Stores your Docker images. ~**$5/month** (Basic tier).

```bash
az acr create \
  --name myrideprod \
  --resource-group rg-myride-prod \
  --sku Basic \
  --admin-enabled true

# Save these — you'll need them as GitHub Secrets:
az acr credential show \
  --name myrideprod \
  --resource-group rg-myride-prod
# Outputs: username, passwords (password + password2)
```

---

## 3. Azure Database for PostgreSQL Flexible Server

~**$15/month** (Burstable B1ms, 32 GB storage).

```bash
az postgres flexible-server create \
  --name myride-db \
  --resource-group rg-myride-prod \
  --location centralindia \
  --admin-user myrideadmin \
  --admin-password "<STRONG_PASSWORD>" \
  --sku-name Standard_B1ms \
  --tier Burstable \
  --storage-size 32 \
  --version 16 \
  --public-access 0.0.0.0  # allow Azure services; tighten later if needed

# Create the application database
az postgres flexible-server db create \
  --server-name myride-db \
  --resource-group rg-myride-prod \
  --database-name myride

# Allow connections from Azure services (Container Apps outbound IPs are dynamic)
az postgres flexible-server firewall-rule create \
  --name AllowAzureServices \
  --server-name myride-db \
  --resource-group rg-myride-prod \
  --start-ip-address 0.0.0.0 \
  --end-ip-address 0.0.0.0
```

### Enable PostGIS (run after server is created)

Connect via psql:
```bash
psql "host=myride-db.postgres.database.azure.com port=5432 dbname=myride user=myrideadmin sslmode=require"
```

Then run:
```sql
-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Verify
SELECT PostGIS_Version();
```

> **Note:** Azure Database for PostgreSQL Flexible Server supports PostGIS natively.  
> If `CREATE EXTENSION` fails with "not in shared_preload_libraries", run:
> ```bash
> az postgres flexible-server parameter set \
>   --name shared_preload_libraries \
>   --value "postgis" \
>   --server-name myride-db \
>   --resource-group rg-myride-prod
> ```
> Then restart the server and retry.

---

## 4. Azure Cache for Redis

~**$16/month** (Basic C0, 250 MB).

```bash
az redis create \
  --name myride-redis \
  --resource-group rg-myride-prod \
  --location centralindia \
  --sku Basic \
  --vm-size c0

# Get the connection string (SSL port 6380)
az redis show \
  --name myride-redis \
  --resource-group rg-myride-prod \
  --query "[hostName, sslPort]"

az redis list-keys \
  --name myride-redis \
  --resource-group rg-myride-prod
# Use primaryKey in your REDIS_URL:
# redis://:primaryKey@myride-redis.redis.cache.windows.net:6380?ssl=true
```

---

## 5. Azure Container Apps Environment

```bash
az containerapp env create \
  --name myride-env \
  --resource-group rg-myride-prod \
  --location centralindia
```

---

## 6. Azure Container App

Min 1 replica, max 3. Port 3000 with external ingress.

```bash
az containerapp create \
  --name myride-api \
  --resource-group rg-myride-prod \
  --environment myride-env \
  --image myrideprod.azurecr.io/myride-api:latest \
  --registry-server myrideprod.azurecr.io \
  --registry-username myrideprod \
  --registry-password "<ACR_PASSWORD>" \
  --target-port 3000 \
  --ingress external \
  --min-replicas 1 \
  --max-replicas 3 \
  --cpu 0.5 \
  --memory 1.0Gi
```

After the first deploy the app gets a URL like:
```
https://myride-api.<random>.centralindia.azurecontainerapps.io
```

---

## 7. LiveKit Cloud (External Service — Not Azure)

LiveKit Cloud is **not** an Azure resource. It's a managed service.

1. Sign up at **https://cloud.livekit.io** (free tier available)
2. Create a new project → note the **API Key**, **API Secret**, and **WebSocket URL** (format: `wss://your-project.livekit.cloud`)
3. These become `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_WS_URL` in your app secrets

---

## App Secrets (Sensitive Env Vars on the Container App)

Set secrets on the Container App. These are stored encrypted by Azure.

```bash
az containerapp secret set \
  --name myride-api \
  --resource-group rg-myride-prod \
  --secrets \
    "database-url=postgresql://myrideadmin:<PASSWORD>@myride-db.postgres.database.azure.com:5432/myride?sslmode=require" \
    "redis-url=redis://:primaryKey@myride-redis.redis.cache.windows.net:6380?ssl=true" \
    "jwt-secret=<MIN_32_CHAR_RANDOM_STRING>" \
    "firebase-service-account-path=/app/secrets/firebase.json" \
    "livekit-api-key=<YOUR_LIVEKIT_API_KEY>" \
    "livekit-api-secret=<YOUR_LIVEKIT_API_SECRET>" \
    "livekit-ws-url=wss://<YOUR_PROJECT>.livekit.cloud"
```

Reference secrets in environment variables:
```bash
az containerapp update \
  --name myride-api \
  --resource-group rg-myride-prod \
  --set-env-vars \
    "NODE_ENV=production" \
    "PORT=3000" \
    "JWT_ACCESS_EXPIRATION=15m" \
    "JWT_REFRESH_EXPIRATION=30d" \
    "ENABLE_FIREBASE=true" \
    "FRONTEND_URL=https://your-frontend-domain.com" \
    "DATABASE_URL=secretref:database-url" \
    "REDIS_URL=secretref:redis-url" \
    "JWT_SECRET=secretref:jwt-secret" \
    "FIREBASE_SERVICE_ACCOUNT_PATH=secretref:firebase-service-account-path" \
    "LIVEKIT_API_KEY=secretref:livekit-api-key" \
    "LIVEKIT_API_SECRET=secretref:livekit-api-secret" \
    "LIVEKIT_WS_URL=secretref:livekit-ws-url"
```

---

## GitHub Secrets to Set

Go to **GitHub → repo → Settings → Secrets and variables → Actions → New repository secret**.

| Secret Name | Value | How to get it |
|---|---|---|
| `AZURE_CREDENTIALS` | Service principal JSON (see below) | `az ad sp create-for-rbac` |
| `AZURE_REGISTRY_LOGIN_SERVER` | `myrideprod.azurecr.io` | Fixed — your ACR login server |
| `AZURE_REGISTRY_USERNAME` | `myrideprod` | From `az acr credential show` |
| `AZURE_REGISTRY_PASSWORD` | ACR password value | From `az acr credential show` → `passwords[0].value` |
| `FRONTEND_URL` | `https://your-frontend-domain.com` | Your frontend URL |

### Create the Service Principal for `AZURE_CREDENTIALS`

```bash
az ad sp create-for-rbac \
  --name sp-myride-github \
  --role contributor \
  --scopes /subscriptions/<SUBSCRIPTION_ID>/resourceGroups/rg-myride-prod \
  --sdk-auth
```

Copy the entire JSON output — it looks like:
```json
{
  "clientId": "...",
  "clientSecret": "...",
  "subscriptionId": "...",
  "tenantId": "...",
  "activeDirectoryEndpointUrl": "...",
  ...
}
```
Paste this as the value for the `AZURE_CREDENTIALS` secret.

---

## GitHub Variables to Set

Go to **GitHub → repo → Settings → Secrets and variables → Actions → Variables tab → New repository variable**.

| Variable Name | Value |
|---|---|
| `AZURE_RESOURCE_GROUP` | `rg-myride-prod` |
| `AZURE_CONTAINER_APP_NAME` | `myride-api` |

---

## Estimated Monthly Cost

| Resource | SKU | Est. cost/mo (USD) |
|---|---|---|
| Azure Container Registry | Basic | ~$5 |
| Azure Database for PostgreSQL Flexible Server | Burstable B1ms | ~$15 |
| Azure Cache for Redis | Basic C0 | ~$16 |
| Azure Container Apps | 1–3 replicas, 0.5 vCPU / 1 GiB | ~$5–15 (usage-based) |
| Container Apps Environment | Shared | ~$0 (free with workloads) |
| LiveKit Cloud | Free tier | $0 (up to 10k mins/mo) |
| **Total (light traffic)** | | **~$40–55/mo** |

> Container Apps pricing is consumption-based: you pay per vCPU-second and GiB-second of active use. At low traffic, the cost is minimal.

---

## Firewall & Networking Notes

### Container App → PostgreSQL
- The `--public-access 0.0.0.0 0.0.0.0` firewall rule allows all Azure-hosted IPs (including Container Apps).
- Container App outbound IPs are dynamic (shared SNAT). The `0.0.0.0` rule covers this.
- For tighter security, retrieve the Container App environment's static IPs and add only those:
  ```bash
  az containerapp env show \
    --name myride-env \
    --resource-group rg-myride-prod \
    --query "properties.staticIp"
  ```

### Container App → Redis
- Azure Cache for Redis (Basic tier) is public-endpoint only. The SSL connection (`ssl=true` in the URL) is already enforced.
- No extra firewall rules needed — Redis accepts connections from Azure services by default.

### SSL/TLS
- The NestJS TypeORM config already has `rejectUnauthorized: false` for production, which handles Azure's self-signed Postgres cert.
- Redis connections should include `ssl=true` (or `tls={}`) in the URL.

---

## Custom Domain + SSL

Azure Container Apps supports custom domains with automatic TLS certificates:

```bash
# 1. Add your domain
az containerapp hostname add \
  --name myride-api \
  --resource-group rg-myride-prod \
  --hostname api.yourdomain.com

# 2. Bind a managed certificate (free, auto-renews)
az containerapp ssl bind \
  --name myride-api \
  --resource-group rg-myride-prod \
  --hostname api.yourdomain.com \
  --environment myride-env
```

Before running these commands, add a **CNAME record** in your DNS:
```
api  →  myride-api.<random>.centralindia.azurecontainerapps.io
```

Azure will automatically provision and renew a Let's Encrypt TLS certificate.

---

## Deployment Verification

After the pipeline runs:
```bash
# Check the app is running
curl https://myride-api.<random>.centralindia.azurecontainerapps.io/

# Check logs (live tail)
az containerapp logs show \
  --name myride-api \
  --resource-group rg-myride-prod \
  --follow

# Check revision status
az containerapp revision list \
  --name myride-api \
  --resource-group rg-myride-prod \
  --output table
```

---

## Quick Reference: All CLI Commands in Order

```bash
# 0. Login
az login

# 1. Resource group
az group create --name rg-myride-prod --location centralindia

# 2. ACR
az acr create --name myrideprod --resource-group rg-myride-prod --sku Basic --admin-enabled true

# 3. PostgreSQL
az postgres flexible-server create \
  --name myride-db --resource-group rg-myride-prod --location centralindia \
  --admin-user myrideadmin --admin-password "<PASSWORD>" \
  --sku-name Standard_B1ms --tier Burstable --storage-size 32 --version 16 \
  --public-access 0.0.0.0

az postgres flexible-server db create \
  --server-name myride-db --resource-group rg-myride-prod --database-name myride

# 4. Redis
az redis create --name myride-redis --resource-group rg-myride-prod \
  --location centralindia --sku Basic --vm-size c0

# 5. Container Apps Environment
az containerapp env create --name myride-env --resource-group rg-myride-prod --location centralindia

# 6. Container App (initial — GitHub Actions will handle subsequent deploys)
az containerapp create \
  --name myride-api --resource-group rg-myride-prod --environment myride-env \
  --image myrideprod.azurecr.io/myride-api:latest \
  --registry-server myrideprod.azurecr.io \
  --registry-username myrideprod --registry-password "<ACR_PASSWORD>" \
  --target-port 3000 --ingress external \
  --min-replicas 1 --max-replicas 3 --cpu 0.5 --memory 1.0Gi

# 7. Set secrets (after filling in real values)
az containerapp secret set --name myride-api --resource-group rg-myride-prod \
  --secrets \
    "database-url=postgresql://myrideadmin:<PASSWORD>@myride-db.postgres.database.azure.com:5432/myride?sslmode=require" \
    "redis-url=redis://:primaryKey@myride-redis.redis.cache.windows.net:6380?ssl=true" \
    "jwt-secret=<MIN_32_CHAR_RANDOM_STRING>" \
    "firebase-service-account-path=/app/secrets/firebase.json" \
    "livekit-api-key=<YOUR_LIVEKIT_API_KEY>" \
    "livekit-api-secret=<YOUR_LIVEKIT_API_SECRET>" \
    "livekit-ws-url=wss://<YOUR_PROJECT>.livekit.cloud"

# 8. Service principal for GitHub Actions
az ad sp create-for-rbac --name sp-myride-github --role contributor \
  --scopes /subscriptions/<SUBSCRIPTION_ID>/resourceGroups/rg-myride-prod --sdk-auth
```
