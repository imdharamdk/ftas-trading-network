# Security Policy

## Supported Versions

The following versions of FTAS (Fintech Automated Solutions) are currently supported with security updates:

| Version | Supported          |
| ------- | ------------------ |
| Latest (main branch) | ✅ Active support |
| Older releases       | ❌ No support     |

We strongly recommend always running the latest version deployed from the `main` branch.

---

## Reporting a Vulnerability

We take security seriously at FTAS. If you discover a vulnerability in this project, please follow the responsible disclosure process below.

### How to Report

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please report privately via one of the following:

- **GitHub Security Advisories:** Go to the repository → Security tab → "Report a vulnerability"
- **Email:** Contact the maintainer directly at the email listed in the repository profile

### What to Include in Your Report

Please provide as much detail as possible:

- A clear description of the vulnerability
- Steps to reproduce the issue
- The potential impact (data exposure, unauthorized access, etc.)
- Any proof-of-concept code or screenshots (if applicable)
- Your suggested fix (optional but appreciated)

### Response Timeline

| Stage | Timeframe |
|-------|-----------|
| Acknowledgement of report | Within 48 hours |
| Initial assessment | Within 5 business days |
| Fix or mitigation | Within 14 days (critical), 30 days (moderate) |
| Public disclosure | After fix is deployed |

---

## Scope

The following areas are **in scope** for security reports:

- Authentication and session management (JWT tokens, TOTP, MPIN handling)
- API key exposure or insecure storage (Angel One SmartAPI, Binance keys)
- Authorization bypass (admin-only routes accessible by regular users)
- Injection vulnerabilities (NoSQL, command injection)
- Sensitive data exposure (user emails, payment references, subscription data)
- Broken access control on signal or payment endpoints
- Insecure direct object references (accessing other users' data)

The following are **out of scope**:

- Denial of service attacks
- Social engineering attacks
- Issues in third-party services (Angel One, Binance, Render, Vercel, MongoDB Atlas)
- Theoretical vulnerabilities without a working proof of concept
- Issues in outdated browsers or unsupported environments

---

## Security Best Practices for Deployment

If you are self-hosting or deploying this project, please ensure the following:

### Environment Variables
- **Never commit `.env` files** to version control
- Rotate `SMART_API_KEY`, `SMART_API_MPIN`, and `SMART_API_TOTP_SECRET` immediately if exposed
- Use Render's secret environment variables or equivalent for all sensitive keys
- `JWT_SECRET` should be a long (32+ character) random string

### API Keys
- Angel One SmartAPI keys should have **minimum required permissions** only
- Regularly rotate TOTP secrets and API keys
- Monitor Angel One portal for unauthorized login activity

### Database
- MongoDB Atlas connection strings must never be public
- Enable Atlas IP allowlist — only allow your Render server IP
- Use a dedicated database user with least-privilege access

### Authentication
- Admin accounts should use strong, unique passwords
- Review the user list regularly and remove inactive accounts
- Payment approvals require admin role — protect admin credentials carefully

---

## Known Security Considerations

- **TOTP secrets** for Angel One are stored as environment variables. Treat these with the same sensitivity as passwords.
- **JWT tokens** are used for session management. Ensure `JWT_SECRET` is kept secret and rotated periodically.
- **Payment references** and user email addresses are stored in MongoDB — ensure Atlas access controls are enforced.
- This project is designed for **private/personal use**. If exposed publicly, ensure all admin routes are protected.

---

## Acknowledgements

We appreciate responsible disclosure from the security community. Researchers who report valid vulnerabilities will be acknowledged (with their permission) in the project's release notes.

---

*Last updated: March 2026*
