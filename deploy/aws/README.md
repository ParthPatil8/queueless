# Deploying QueueLess on AWS (AWS Academy Learner Lab)

Based on how Learner Lab usually works (check your course rules): you cannot create IAM roles, so use the existing **LabInstanceProfile**; resources stop when the lab session ends; the EC2 public IP changes after a restart.

## Option A: CloudFormation (fast)
1. Push the project to a **public** GitHub repo.
2. Console > CloudFormation > Create stack > Upload `deploy/aws/queueless-stack.yml`.
3. Fill the parameters: your default VPC, one public subnet, two DB subnets (different AZs), your repo URL, an admin password (letters and digits, 12+), a DB password (letters and digits, 12+). Leave `InstanceProfileName` as `LabInstanceProfile`.
4. Wait for CREATE_COMPLETE (RDS takes ~10 minutes), then open the **AppUrl** output after another ~5-8 minutes (the instance is building the Docker image).
5. Sign in at `/staff/login` with `AdminUsername` / `AdminPassword`. Admin > Backend shows "PostgreSQL" and "In a container: Yes".
6. Cleanup: delete the stack, then empty and delete the S3 bucket.

## Option B: by hand in the console (shows each service)
1. **Security groups:** `queueless-app` (inbound HTTP 80 from anywhere) and `queueless-db` (inbound PostgreSQL 5432, source = the `queueless-app` group).
2. **RDS:** create a PostgreSQL database `queueless`, user `queueless`, **Public access: No**, security group `queueless-db`, encryption on.
3. **S3:** create a private bucket (block all public access, default encryption on, versioning on).
4. **EC2:** Amazon Linux 2023, security group `queueless-app`, IAM instance profile **LabInstanceProfile**, require IMDSv2. Then connect (EC2 Instance Connect) and run:
```bash
sudo dnf install -y docker git && sudo systemctl enable --now docker
git clone <your-repo-url> && cd <repo> && sudo docker build -t queueless .
sudo docker run -d --name queueless --restart unless-stopped -p 80:4000 \
  -e NODE_ENV=production -e DATABASE_SSL=true \
  -e DATABASE_URL=postgres://queueless:DBPASSWORD@RDS-ENDPOINT:5432/queueless \
  -e S3_BUCKET=BUCKET -e S3_REGION=us-east-1 \
  -e ADMIN_USERNAME=admin -e ADMIN_PASSWORD=ADMINPASSWORD \
  -e COOKIE_SECURE=false -e TRUST_PROXY=0 -e LOG_FORMAT=json queueless
```
5. Open `http://EC2-PUBLIC-IP`, sign in, open Admin > Backend, press **Back up database to S3**, and show the new object in the bucket.

Not verified on a real AWS account: this guide, the template and the S3 upload were written without AWS access.
