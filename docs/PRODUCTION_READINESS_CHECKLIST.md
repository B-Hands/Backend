# Production Readiness Checklist

Use this checklist for every production release. Copy into your release ticket or PR template to ensure no steps are missed.

---

## Pre-Release Validation (24 hours before)

### Database

- [ ] **Backup current production DB**
  ```bash
  # Command (adjust for your provider)
  aws rds create-db-snapshot \
    --db-instance-identifier neurowealth-prod \
    --db-snapshot-identifier neurowealth-prod-$(date +%Y%m%d-%H%M%S)
  # Verify: https://console.aws.amazon.com/rds/home#databases:
  ```

- [ ] **Review pending migrations**
  ```bash
  # Show all pending migrations
  npx prisma migrate status
  
  # Test migrations in staging first
  DATABASE_URL="postgresql://staging..." npx prisma migrate deploy
  ```

- [ ] **Test migration rollback**
  ```bash
  # Ensure you can revert if needed (migrations must be reversible)
  # Step 1: Identify current migration
  psql "$DATABASE_URL" -c "SELECT * FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 1;"
  
  # Step 2: Document rollback procedure
  # Rollback: Reset DB to prior state from backup (document snapshot ID)
  ```

- [ ] **Check schema compatibility**
  ```bash
  # Ensure no breaking column/table deletions in migration
  psql "$DATABASE_URL" -c "
    SELECT table_name, column_name, is_nullable, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name;
  " | head -50
  ```

- [ ] **Verify DB connection pooling**
  ```bash
  # Check pool size in env
  grep "DATABASE_URL" .env.production | grep -oE "pool_size=[0-9]+"
  
  # Expected: pool_size=20-30 for production
  ```

### Secrets & Credentials

- [ ] **Rotate secrets if scheduled (quarterly)**
  ```bash
  # JWT_SEED rotation (invalidates all sessions)
  # Steps in docs/RUNBOOK.md § Key Custody
  
  # Verify new secret is set
  echo "JWT_SEED length: ${#JWT_SEED}"  # Should be ~50+ chars
  ```

- [ ] **Verify STELLAR_AGENT_SECRET_KEY**
  ```bash
  # Check network alignment (must be MAINNET for production)
  echo "STELLAR_NETWORK=$STELLAR_NETWORK"  # Must be "mainnet"
  echo "STELLAR_AGENT_SECRET_KEY starts with S: ${STELLAR_AGENT_SECRET_KEY:0:1}"
  
  # Verify key length (56 chars)
  echo "Key length: ${#STELLAR_AGENT_SECRET_KEY}"
  ```

- [ ] **Verify WALLET_ENCRYPTION_KEY**
  ```bash
  # 64 hex characters for AES-256-GCM
  echo "Key length: ${#WALLET_ENCRYPTION_KEY}"
  [[ ${#WALLET_ENCRYPTION_KEY} -eq 64 ]] && echo "✓ Valid" || echo "✗ Invalid"
  ```

- [ ] **Check all required env vars are set**
  ```bash
  # Startup validation runs this automatically
  # Manual check:
  node -e "require('./dist/config/env.ts').config()"
  ```

- [ ] **Audit secret access logs**
  ```bash
  # AWS Secrets Manager
  aws secretsmanager list-secret-version-ids --secret-id neurowealth/prod \
    --query 'Versions[0:10]'
  
  # Check who accessed secrets in last 7 days
  aws cloudtrail lookup-events \
    --lookup-attributes AttributeKey=ResourceName,AttributeValue=neurowealth/prod \
    --start-time $(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%S)
  ```

### Observability

- [ ] **Verify Prometheus scrape target is healthy**
  ```bash
  # Check Prometheus config
  curl -s http://prometheus:9090/api/v1/targets | jq '.data.activeTargets[] | select(.labels.job=="neurowealth-backend")'
  
  # Expected: `"health": "up"`, scrape success rate ~100%
  ```

- [ ] **Configure alert thresholds (from OBSERVABILITY.md)**
  ```bash
  # Critical alerts defined:
  # - agent_loop_status == 0 (stopped)
  # - cursor_lag_ledgers > 100
  # - dlq_size > 50
  # - failures_total rate > 10/min
  
  # Verify in Prometheus: http://prometheus:9090/alerts
  ```

- [ ] **Set up Grafana dashboard**
  ```bash
  # Import dashboard from docs/grafana-dashboard.json
  curl -X POST http://grafana:3000/api/dashboards/db \
    -H "Authorization: Bearer $GRAFANA_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d @docs/grafana-dashboard.json
  ```

- [ ] **Enable log aggregation**
  ```bash
  # Verify logs ship to centralized store (CloudWatch, DataDog, etc.)
  # Check last log entry in console
  docker logs neurowealth-backend | tail -5
  ```

- [ ] **Verify /metrics endpoint is accessible (internally only)**
  ```bash
  # Should only be accessible from internal network
  curl http://localhost:3001/metrics | head -20
  ```

### Rollback Plan

- [ ] **Document current image tag / git commit**
  ```bash
  # Capture current state before deploying new version
  git rev-parse HEAD > PROD_DEPLOY_COMMIT.txt
  docker image inspect neurowealth-backend:prod | grep -i digest
  ```

- [ ] **Test rollback procedure in staging**
  ```bash
  # 1. Deploy new version to staging
  # 2. Identify breaking issue
  # 3. Re-deploy previous image
  # 4. Verify /health/ready returns 200
  ```

- [ ] **Create runbook entry for incident**
  - [ ] Link to this checklist
  - [ ] Escalation path (T1 → T2 → T3 from RUNBOOK.md § Incident Contacts)
  - [ ] Rollback command (see below)

---

## Release Day (2 hours before deployment)

### Code Verification

- [ ] **Run full test suite locally**
  ```bash
  npm test 2>&1 | tee test-run.log
  # Verify: "PASSED" in final line
  # Check for skipped tests: grep "skip\|pending" test-run.log
  ```

- [ ] **Run type checking**
  ```bash
  npx tsc --noEmit
  # Expected: no errors
  ```

- [ ] **Run linting**
  ```bash
  npm run lint
  # Expected: no errors (warnings OK with approval)
  ```

- [ ] **Review diff from last release**
  ```bash
  git log --oneline v1.2.3..HEAD
  git diff v1.2.3..HEAD -- src/ | wc -l
  # Flag: >500 lines → require additional review
  ```

### Build Verification

- [ ] **Build Docker image**
  ```bash
  docker build -t neurowealth-backend:v1.3.0 .
  docker build -t neurowealth-backend:latest .
  ```

- [ ] **Smoke test image locally**
  ```bash
  docker run -d --name test-container \
    -e NODE_ENV=production \
    -e DATABASE_URL="postgresql://test" \
    neurowealth-backend:v1.3.0
  
  # Wait for startup
  sleep 10
  
  # Check basic health
  docker exec test-container curl http://localhost:3001/health
  # Expected: "status": "ok"
  
  docker rm -f test-container
  ```

- [ ] **Check image size**
  ```bash
  docker image ls neurowealth-backend:v1.3.0
  # Flag: >500MB → investigate bloat
  ```

- [ ] **Verify no secrets in image**
  ```bash
  docker history neurowealth-backend:v1.3.0 | grep -E "SECRET|PASSWORD|API_KEY"
  # Expected: no output
  ```

### Staging Deployment

- [ ] **Deploy to staging environment**
  ```bash
  # Use same deployment scripts/templates as production
  kubectl apply -f deploy/k8s/staging/ --dry-run=client -o yaml | head -50
  kubectl apply -f deploy/k8s/staging/
  ```

- [ ] **Wait for staging to become ready**
  ```bash
  kubectl -n neurowealth-staging wait --for=condition=ready pod \
    -l app=neurowealth-backend \
    --timeout=300s
  
  # Verify readiness probe
  kubectl -n neurowealth-staging get pods -o wide
  # Expected: STATUS="Running", READY="1/1"
  ```

- [ ] **Run integration tests against staging**
  ```bash
  npm run test:integration -- --endpoint="https://staging-api.neurowealth.io"
  # All tests must pass
  ```

- [ ] **Check staging logs for errors**
  ```bash
  kubectl -n neurowealth-staging logs \
    -l app=neurowealth-backend \
    --tail=50 | grep -i "error\|fail\|crash"
  # Expected: no critical errors
  ```

- [ ] **Verify staging health endpoints**
  ```bash
  curl https://staging-api.neurowealth.io/health/ready | jq '.subsystems'
  # Expected: { "database": true, "eventListener": true, "agentLoop": true }
  ```

- [ ] **Load test staging (optional)**
  ```bash
  # Use Apache Bench or k6
  ab -n 1000 -c 10 https://staging-api.neurowealth.io/api/portfolio
  # Expected: p95 response time < 500ms
  ```

---

## Deployment (Production)

### Pre-Deployment Window

- [ ] **Notify team of deployment**
  - [ ] Post in `#neurowealth-deployments` Slack channel
  - [ ] Expected duration: ~10 min
  - [ ] Estimated completion time: HH:MM UTC

- [ ] **Verify no concurrent deployments**
  ```bash
  kubectl get deployments -n neurowealth | grep neurowealth-backend
  # Check status: no "Progressing" condition if previous deploy still running
  ```

- [ ] **Clear DLQ before deployment (if any)**
  ```bash
  # Retry pending events first
  curl -X POST -H "Authorization: Bearer $ADMIN_API_TOKEN" \
    http://prod-api.neurowealth.io/api/admin/dlq/retry
  
  # Check remaining count
  psql "$PROD_DATABASE_URL" -c "SELECT status, COUNT(*) FROM dead_letter_events GROUP BY status;"
  ```

### Deployment Execution

- [ ] **Deploy new image to production**
  ```bash
  # Option 1: kubectl rolling update
  kubectl -n neurowealth set image deployment/neurowealth-backend \
    app=neurowealth-backend:v1.3.0
  
  # Option 2: re-apply manifest
  kubectl apply -f deploy/k8s/production/deployment.yaml
  ```

- [ ] **Monitor rollout progress**
  ```bash
  kubectl -n neurowealth rollout status deployment/neurowealth-backend --timeout=300s
  
  # If it hangs, check pod logs
  kubectl -n neurowealth logs -l app=neurowealth-backend --tail=50
  ```

- [ ] **Verify production pods are ready**
  ```bash
  kubectl -n neurowealth get pods -o wide
  # Expected: all pods STATUS="Running", READY="1/1"
  
  # Check specific pod readiness
  kubectl -n neurowealth describe pod <pod-name> | grep -A 10 "Readiness"
  ```

- [ ] **Verify production health endpoint**
  ```bash
  curl https://api.neurowealth.io/health/ready | jq '.'
  # Expected:
  # {
  #   "ready": true,
  #   "subsystems": { "database": true, "eventListener": true, "agentLoop": true }
  # }
  ```

### Post-Deployment Validation (15 min)

- [ ] **Check error rate in logs**
  ```bash
  kubectl -n neurowealth logs -l app=neurowealth-backend \
    --since=2m | grep -c "ERROR\|FATAL"
  # Expected: < 5 errors in first 2 minutes
  ```

- [ ] **Monitor key metrics (Prometheus/Grafana)**
  - [ ] `http_request_duration_seconds` p95 < 1 sec (no spike)
  - [ ] `failure_rate` < 1% (no elevated errors)
  - [ ] `cursor_lag_ledgers` < 50 (event processing normal)
  - [ ] `dlq_size` unchanged (no new DLQ events)
  - [ ] `agent_loop_status` == 1 (running)

- [ ] **Run production smoke tests**
  ```bash
  npm run test:smoke -- --endpoint="https://api.neurowealth.io"
  # At minimum:
  # - GET /health → 200
  # - GET /health/ready → 200
  # - POST /api/auth/... → valid JWT
  # - GET /api/portfolio (with valid JWT) → 200
  ```

- [ ] **Verify at least one event was processed**
  ```bash
  psql "$PROD_DATABASE_URL" -c "
    SELECT COUNT(*) FROM processed_events 
    WHERE created_at > NOW() - INTERVAL '5 minutes';
  "
  # Expected: > 0
  ```

- [ ] **Check DLQ remains stable**
  ```bash
  curl -s -H "Authorization: Bearer $ADMIN_API_TOKEN" \
    https://api.neurowealth.io/api/admin/dlq/inspect | jq 'length'
  # Expected: unchanged from pre-deployment check
  ```

---

## Post-Deployment (1 hour)

- [ ] **Update version in CHANGELOG.md**
  ```markdown
  ## [1.3.0] - 2026-06-24
  
  ### Added
  - Feature X
  
  ### Fixed
  - Bug Y
  ```

- [ ] **Tag release in git**
  ```bash
  git tag -a v1.3.0 -m "Production release: Feature X, Bug Y fix"
  git push origin v1.3.0
  ```

- [ ] **Update deployment docs**
  ```bash
  # Document any manual steps or gotchas
  # Update DEPLOYMENT.md if procedure changed
  ```

- [ ] **Notify team of successful deployment**
  - [ ] Post in `#neurowealth-deployments`
  - [ ] Include: version, commits deployed, metrics snapshot

- [ ] **Schedule post-mortem if issues occurred**
  - [ ] Create entry in `docs/post-mortems/`
  - [ ] Include timeline, root cause, remediation

---

## Rollback Procedure (if needed)

### Detect Rollback Triggers

- [ ] **Readiness probe failing**
  ```bash
  curl https://api.neurowealth.io/health/ready
  # If status_code != 200 after 5 minutes → ROLLBACK
  ```

- [ ] **High error rate**
  ```bash
  # Alert fires: failures_total rate > 10/min for 2 min → ROLLBACK
  kubectl -n neurowealth logs -l app=neurowealth-backend --tail=100 | grep ERROR | wc -l
  ```

- [ ] **Database migration failure**
  ```bash
  # If Prisma migration fails, pods won't start
  kubectl -n neurowealth describe pods | grep "CrashLoopBackOff"
  ```

### Execute Rollback

- [ ] **Revert to previous image**
  ```bash
  # Get previous image from deployment history
  kubectl -n neurowealth rollout history deployment/neurowealth-backend
  
  # Rollback to previous revision
  kubectl -n neurowealth rollout undo deployment/neurowealth-backend
  
  # Verify rollback
  kubectl -n neurowealth rollout status deployment/neurowealth-backend --timeout=300s
  ```

- [ ] **Verify services restored**
  ```bash
  curl https://api.neurowealth.io/health/ready
  # Must return 200 with all subsystems true
  ```

- [ ] **Notify team of rollback**
  - [ ] Post in `#neurowealth-incidents`
  - [ ] Include: version rolled back, reason, status

- [ ] **Investigate root cause**
  - [ ] Collect logs from failed deployment
  - [ ] Review metrics around failure time
  - [ ] Create post-mortem entry

---

## Commands Quick Reference

```bash
# Check current production version
kubectl -n neurowealth describe deployment neurowealth-backend | grep Image

# View deployment history
kubectl -n neurowealth rollout history deployment/neurowealth-backend

# Undo last deployment
kubectl -n neurowealth rollout undo deployment/neurowealth-backend

# Get logs from last 1 hour
kubectl -n neurowealth logs -l app=neurowealth-backend --since=1h

# Port-forward for local debugging
kubectl -n neurowealth port-forward svc/neurowealth-backend 3001:3001

# Check pod events and issues
kubectl -n neurowealth describe pod <pod-name>

# Stream live logs
kubectl -n neurowealth logs -f -l app=neurowealth-backend
```

---

## Approval Sign-Off

```
Release Version: ____________________
Deployed by: ____________________  (Name)
Deployment Date/Time: ____________________
All checks passed: ☐ Yes ☐ No
Signed off by: ____________________  (Name, Title)
```
