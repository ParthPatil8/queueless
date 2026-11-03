# QueueLess: cloud computing features

## Service models: where QueueLess fits
| Model | In this project |
|---|---|
| **SaaS** | QueueLess itself. Customers, staff and admins use it in a browser; nothing to install. |
| **PaaS** | Render: you push code to GitHub, the platform builds, runs, restarts and puts HTTPS in front. You manage only the app. |
| **IaaS** | AWS EC2 + RDS + S3 + VPC: you choose the VM, install Docker, set security groups. Template: `deploy/aws/queueless-stack.yml`. |
| **Containers** | `Dockerfile` (multi-stage, non-root, health check) and `docker-compose.yml` (app + PostgreSQL). |

## What was added, and how far it was checked
| Feature | Where | Status |
|---|---|---|
| Database connectivity: PostgreSQL (RDS-compatible) **or** SQLite, chosen by `DATABASE_URL` | `backend/src/db.js` | **Built and tested.** Full test suite (16 tests) passes on SQLite *and* on real PostgreSQL 16. 15 simultaneous joins gave 15 unique tokens; 5 simultaneous "call next" clicks called 5 different tokens |
| S3 backup (admin button, encrypted object, uses the server's IAM role) | `POST /api/admin/backup` | Logic tested with a stubbed S3. **Not run against real S3** (no AWS account here) |
| Structured JSON logs (CloudWatch-ready), request + audit lines | `LOG_FORMAT=json` | **Built and tested** |
| Health check with engine and uptime | `GET /api/health` | **Built and tested** |
| HTTPS redirect behind a load balancer | `FORCE_HTTPS=true` | **Built and tested** |
| Proxy trust and cookie settings for EC2 / PaaS | `TRUST_PROXY`, `COOKIE_SECURE` | **Built and tested** |
| Graceful shutdown on SIGTERM (docker stop, EC2 stop) | `server.js` | Built |
| Cloud panel: DB engine, container, S3, security settings | Admin > Backend | **Built and tested** |
| Docker image + compose | `Dockerfile`, `docker-compose.yml` | **Not built or run** (Docker was not available here). I checked the same steps by hand: production-only install, then the server booted against PostgreSQL |
| CloudFormation: security groups, EC2, RDS, S3, IMDSv2 | `deploy/aws/queueless-stack.yml` | Passes `cfn-lint` (one warning: secrets passed as parameters). **Never deployed to AWS** |
| CI: tests on SQLite + PostgreSQL, build, audit, Docker build | `.github/workflows/ci.yml` | YAML parses; has not run on GitHub yet |

## AWS Academy concepts, mapped
| Concept | How it appears |
|---|---|
| **IAM** | The EC2 instance profile (role) lets the app write to S3. The code has no access keys: the AWS SDK picks up the role automatically. In the app, roles (customer/staff/admin) are enforced on every route. |
| **Security groups** | App group: HTTP 80 from anywhere, SSH only if you set a CIDR. DB group: PostgreSQL 5432 **only from the app group**. The DB is not publicly accessible. |
| **EC2** | Runs the Docker container (`docker run -p 80:4000 ...`). |
| **RDS** | PostgreSQL 16, encrypted storage, private. The app connects with `DATABASE_URL` and `DATABASE_SSL=true`. |
| **S3** | Private, encrypted, versioned bucket; bucket policy denies non-HTTPS access; backups go to `backups/`. |
| **VPC / subnets** | Template parameters: one public subnet for EC2, two subnets for the RDS subnet group. |
| **CloudWatch** | Logs are JSON on stdout, ready for the CloudWatch agent. **Not configured** in the template. |
| **Load balancer / ACM (HTTPS)** | Not included. `FORCE_HTTPS`, `TRUST_PROXY` and `COOKIE_SECURE` are ready for when one is added. |

## New settings
| Variable | Meaning |
|---|---|
| `DATABASE_URL` | `postgres://user:pass@host:5432/db`. Unset = SQLite file. |
| `DATABASE_SSL` | `true` for RDS (it requires TLS). Uses TLS without verifying the certificate: acceptable for a lab, for production load the RDS CA bundle. |
| `S3_BUCKET`, `S3_REGION` | Enable the S3 backup button. |
| `LOG_FORMAT` | `json` for structured logs. |
| `COOKIE_SECURE` | Default is true in production. Set `false` only for plain-HTTP lab demos (browsers drop Secure cookies over HTTP). |
| `TRUST_PROXY` | Number of proxies in front (default 1 in production). Use `0` when the container is exposed directly, so clients cannot fake `X-Forwarded-For`. |
| `FORCE_HTTPS` | `true` behind a TLS-terminating proxy. |

## Run it
- Local containers: create `.env` with `POSTGRES_PASSWORD=<letters and digits>` and `ADMIN_PASSWORD=<12+ chars>`, then `docker compose up --build`, open http://localhost:4000.
- AWS: see `deploy/aws/README.md`.

## Honest limits
Passwords given to CloudFormation end up in the EC2 user data (visible to anyone who can read the instance). Fine for a lab; use Secrets Manager or Parameter Store for real use. HTTP-only EC2 means traffic is unencrypted. Free tiers and Learner Lab sessions stop or reset resources.
