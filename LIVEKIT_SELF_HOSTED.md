# Self-Hosted LiveKit on Azure VM

This guide sets up LiveKit on a dedicated Azure VM (`vm-myride-livekit`) instead of
using LiveKit Cloud.

**Why a VM instead of Container Apps?**  
Azure Container Apps does not support UDP traffic. WebRTC (which LiveKit uses for
audio) requires UDP ports 50000–50100 to be reachable from the public internet.
A VM with a static public IP and open NSG rules is the correct deployment target.

---

## Cost

| Resource | SKU | Est. cost/mo |
|----------|-----|-------------|
| Azure VM | Standard_B1s (1 vCPU, 1 GiB RAM) | ~$8 |
| Public IP (static) | Basic | ~$4 |
| OS disk (30 GiB) | Standard SSD | ~$2 |
| **Total** | | **~$14/mo** |

> Standard_B1s handles ~20–30 concurrent voice participants comfortably.
> Scale up to B2s (~$17/mo) for larger groups.

---

## Step 1 — Create the VM

```bash
# Static public IP (required — LiveKit advertises this IP in ICE candidates)
az network public-ip create \
  --name pip-livekit \
  --resource-group rg-myride-prod \
  --location centralindia \
  --allocation-method Static \
  --sku Basic

# Network security group
az network nsg create \
  --name nsg-livekit \
  --resource-group rg-myride-prod \
  --location centralindia

# NSG rules — open all ports LiveKit needs
# SSH (management)
az network nsg rule create \
  --nsg-name nsg-livekit \
  --resource-group rg-myride-prod \
  --name allow-ssh \
  --priority 100 \
  --protocol Tcp \
  --destination-port-ranges 22 \
  --access Allow

# LiveKit WebSocket signalling
az network nsg rule create \
  --nsg-name nsg-livekit \
  --resource-group rg-myride-prod \
  --name allow-livekit-ws \
  --priority 110 \
  --protocol Tcp \
  --destination-port-ranges 7880 \
  --access Allow

# LiveKit TCP fallback for WebRTC
az network nsg rule create \
  --nsg-name nsg-livekit \
  --resource-group rg-myride-prod \
  --name allow-livekit-tcp \
  --priority 120 \
  --protocol Tcp \
  --destination-port-ranges 7881 \
  --access Allow

# TURN server (UDP + TCP) for clients behind strict firewalls
az network nsg rule create \
  --nsg-name nsg-livekit \
  --resource-group rg-myride-prod \
  --name allow-turn \
  --priority 130 \
  --protocol "*" \
  --destination-port-ranges 3478 \
  --access Allow

# WebRTC media UDP ports (the most important rule)
az network nsg rule create \
  --nsg-name nsg-livekit \
  --resource-group rg-myride-prod \
  --name allow-webrtc-udp \
  --priority 140 \
  --protocol Udp \
  --destination-port-ranges "50000-50100" \
  --access Allow

# Create the VM
az vm create \
  --name vm-myride-livekit \
  --resource-group rg-myride-prod \
  --location centralindia \
  --image Ubuntu2204 \
  --size Standard_B1s \
  --admin-username azureuser \
  --generate-ssh-keys \
  --public-ip-address pip-livekit \
  --nsg nsg-livekit \
  --os-disk-size-gb 30 \
  --storage-sku StandardSSD_LRS

# Get the public IP (note this down — you'll use it everywhere)
az network public-ip show \
  --name pip-livekit \
  --resource-group rg-myride-prod \
  --query ipAddress \
  --output tsv
```

---

## Step 2 — Install Docker on the VM

```bash
# SSH in (replace 1.2.3.4 with your VM's public IP)
ssh azureuser@1.2.3.4

# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker azureuser

# Install Docker Compose plugin
sudo apt-get install -y docker-compose-plugin

# Verify
docker --version
docker compose version

# Log out and back in so group change takes effect
exit
ssh azureuser@1.2.3.4
```

---

## Step 3 — Create the LiveKit secrets file

This file holds the API key and secret. It is **never committed to git**.

```bash
# SSH into VM
ssh azureuser@1.2.3.4

# Create the secrets file
sudo mkdir -p /etc/livekit
sudo tee /etc/livekit.env > /dev/null << 'EOF'
# LiveKit API credentials — keep secret!
# Format: "apiKey: apiSecret"
# Generate a strong secret: openssl rand -hex 32
LIVEKIT_KEYS="myride-prod-key: REPLACE_WITH_STRONG_SECRET_MIN_32_CHARS"
EOF

sudo chmod 600 /etc/livekit.env

# Create deployment directory
sudo mkdir -p /opt/myride-livekit
sudo chown azureuser:azureuser /opt/myride-livekit
```

Generate a strong secret:
```bash
openssl rand -hex 32
# Example output: a7f3d9e2b1c8f4a6d0e5b2c9f7a3d1e8b4c6f0a2d8e5b1c7f3a9d2e6b0c4f8a1
```

---

## Step 4 — Create the SSH key for GitHub Actions

GitHub Actions needs to SSH into the VM to deploy. Create a dedicated key pair:

```bash
# On your LOCAL machine (not the VM)
ssh-keygen -t ed25519 -f ~/.ssh/myride-livekit-deploy -N "" -C "github-actions-livekit"

# Copy the public key to the VM
ssh-copy-id -i ~/.ssh/myride-livekit-deploy.pub azureuser@1.2.3.4

# Verify it works
ssh -i ~/.ssh/myride-livekit-deploy azureuser@1.2.3.4 "echo connected"
```

Now add the **private key** as a GitHub Secret:
```bash
# Print the private key — copy this entire output including BEGIN/END lines
cat ~/.ssh/myride-livekit-deploy
```

---

## Step 5 — Set GitHub Secrets for LiveKit deployment

Go to **GitHub → repo → Settings → Secrets and variables → Actions**

| Secret | Value |
|--------|-------|
| `LIVEKIT_VM_HOST` | VM public IP (e.g. `1.2.3.4`) |
| `LIVEKIT_VM_USER` | `azureuser` |
| `LIVEKIT_VM_SSH_KEY` | Contents of `~/.ssh/myride-livekit-deploy` (private key) |

---

## Step 6 — First manual deploy

Before the GitHub Action runs for the first time, do a manual deploy to verify everything works:

```bash
# From your LOCAL machine — copy the config files
scp livekit.prod.yaml docker-compose.livekit.yml azureuser@1.2.3.4:/opt/myride-livekit/

# SSH in and start LiveKit
ssh azureuser@1.2.3.4

cd /opt/myride-livekit
docker compose -f docker-compose.livekit.yml up -d

# Check it's running
docker compose -f docker-compose.livekit.yml ps
docker compose -f docker-compose.livekit.yml logs -f
```

You should see:
```
LiveKit server starting...
Using single-node mode
Registered signal handler
...
INFO  server listening  {"addr": ":7880", "nodeID": "ND_..."}
```

Test the health endpoint:
```bash
curl http://1.2.3.4:7881/
# → 200 OK
```

---

## Step 7 — Update the NestJS API env vars

Now that LiveKit has a real IP, update the Container App secrets:

```bash
# Get your VM public IP
VM_IP=$(az network public-ip show \
  --name pip-livekit \
  --resource-group rg-myride-prod \
  --query ipAddress -o tsv)

echo "LiveKit VM IP: $VM_IP"

# Update the secrets on the Container App
az containerapp secret set \
  --name myride-api \
  --resource-group rg-myride-prod \
  --secrets \
    "livekit-ws-url=ws://$VM_IP:7880" \
    "livekit-api-key=myride-prod-key" \
    "livekit-api-secret=REPLACE_WITH_STRONG_SECRET_MIN_32_CHARS"

# Restart the Container App so it picks up the new secrets
az containerapp revision restart \
  --name myride-api \
  --resource-group rg-myride-prod \
  --revision $(az containerapp revision list \
    --name myride-api \
    --resource-group rg-myride-prod \
    --query "[0].name" -o tsv)
```

---

## Step 8 — Update the Android app .env

Update `LIVEKIT_WS_URL` in the mobile app's `.env` (and in `src/services/api/voice.ts` if it has a hardcoded fallback):

```env
# .env in myride-app
EXPO_PUBLIC_API_URL=https://myride-api.<random>.centralindia.azurecontainerapps.io/api/v1
```

The mobile app gets the LiveKit WS URL + token from the API (`POST /trips/:id/voice-call/token`), so the Android app itself doesn't need the VM IP directly — it comes from the backend token endpoint.

---

## GitHub Actions Auto-Deploy

The workflow `.github/workflows/deploy-livekit.yml` automatically:
1. **Triggers** when `livekit.prod.yaml` or `docker-compose.livekit.yml` changes on `main`
2. **SCPs** the updated config files to `/opt/myride-livekit/` on the VM
3. **SSHs** in, pulls the latest `livekit/livekit-server:latest` image, and restarts the container

For most operational changes (tuning room settings, adjusting timeouts), just edit `livekit.prod.yaml` and push — the pipeline handles the rest.

---

## Updating LiveKit Server Version

LiveKit releases new versions frequently. To update:

```bash
# Option 1: Trigger the GitHub Action (pulls :latest automatically)
# Go to GitHub → Actions → "Deploy LiveKit to Azure VM" → Run workflow

# Option 2: SSH in manually
ssh azureuser@1.2.3.4
cd /opt/myride-livekit
docker compose -f docker-compose.livekit.yml pull
docker compose -f docker-compose.livekit.yml up -d
```

To pin to a specific version instead of `:latest`, edit `docker-compose.livekit.yml`:
```yaml
image: livekit/livekit-server:v1.7.2   # pin to specific version
```

---

## Monitoring

```bash
# Tail live logs
ssh azureuser@1.2.3.4 "docker compose -f /opt/myride-livekit/docker-compose.livekit.yml logs -f"

# Check resource usage
ssh azureuser@1.2.3.4 "docker stats myride-livekit --no-stream"

# Check who's connected to a room (via LiveKit API)
curl -H "Authorization: Bearer <admin-token>" \
  http://1.2.3.4:7880/twirp/livekit.RoomService/ListRooms \
  -d '{}'
```

---

## Troubleshooting

### Clients connect but no audio (ICE failure)
UDP ports are not open. Verify the NSG rule:
```bash
az network nsg rule show \
  --nsg-name nsg-livekit \
  --resource-group rg-myride-prod \
  --name allow-webrtc-udp
```
And test from your machine:
```bash
nc -zvu 1.2.3.4 50001   # should connect
```

### "use_external_ip: true" not working
LiveKit can't detect its own public IP. Set it explicitly in `livekit.prod.yaml`:
```yaml
rtc:
  use_external_ip: false
  node_ip: 1.2.3.4        # your VM's actual public IP
```

### Container exits immediately
Check logs:
```bash
ssh azureuser@1.2.3.4 "docker logs myride-livekit --tail=50"
```
Most common cause: `/etc/livekit.env` missing or `LIVEKIT_KEYS` format wrong.
Correct format: `LIVEKIT_KEYS="apikey: apisecret"` (note the space after colon).

### High CPU on B1s VM
B1s is burstable — it accumulates CPU credits during idle. Heavy sustained load
(>20 concurrent participants) can exhaust credits. Upgrade to B2s:
```bash
az vm resize \
  --name vm-myride-livekit \
  --resource-group rg-myride-prod \
  --size Standard_B2s
```

---

## Full Architecture with Self-Hosted LiveKit

```
Android App
    │
    ├─── HTTPS ──► Azure Container Apps (NestJS API)
    │                   │
    │                   ├─── PostgreSQL Flexible Server
    │                   ├─── Azure Cache for Redis
    │                   └─── GET /voice-call/token ──► returns { token, ws_url }
    │
    └─── WSS/UDP ──► Azure VM: vm-myride-livekit
                         Static IP: 1.2.3.4
                         Port 7880 (WS signalling)
                         Port 7881 (TCP fallback)
                         Ports 50000-50100/UDP (media)
```

The API issues a signed JWT token to the Android app. The app uses that token to
connect directly to the LiveKit VM — the API is not in the media path, keeping
latency low.
