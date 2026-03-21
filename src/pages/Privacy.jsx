import { Link } from "react-router-dom";

const LAST_UPDATED = "March 21, 2026";

export default function Privacy() {
  return (
    <div className="public-page legal-page">
      <header className="public-header">
        <div>
          <span className="eyebrow">Fintech Automated Solutions</span>
          <h1>Privacy Policy</h1>
          <p className="muted-copy">How FTAS collects, uses, and protects your information.</p>
        </div>
        <nav className="public-links">
          <Link to="/">Login</Link>
          <Link to="/signup">Signup</Link>
          <Link to="/terms">Terms of Service</Link>
        </nav>
      </header>

      <section className="legal-card">
        <div className="legal-meta">
          <span className="pill pill-neutral">Last updated: {LAST_UPDATED}</span>
          <span className="pill pill-neutral">Brand: Fintech Automated Solutions (FTAS)</span>
        </div>

        <p>
          This Privacy Policy explains how Fintech Automated Solutions ("FTAS", "we", "us", "our") collects,
          uses, and shares information when you use our Services. By using the Services, you agree to this Policy.
        </p>

        <div className="legal-section">
          <h2>1. Information we collect</h2>
          <ul className="legal-list">
            <li>Account data: name, email address, and password (stored in hashed form).</li>
            <li>Usage data: pages visited, features used, actions taken, and timestamps.</li>
            <li>Device and log data: IP address, browser type, device identifiers, and crash logs.</li>
            <li>Payment and billing data: plan selection and payment status (handled via payment providers).</li>
            <li>Support data: messages and files you share with our support team.</li>
          </ul>
        </div>

        <div className="legal-section">
          <h2>2. How we use information</h2>
          <ul className="legal-list">
            <li>Provide, operate, and improve the Services.</li>
            <li>Authenticate users and secure accounts.</li>
            <li>Process payments and manage subscriptions.</li>
            <li>Analyze usage, troubleshoot issues, and monitor performance.</li>
            <li>Communicate service updates, security alerts, and support responses.</li>
          </ul>
        </div>

        <div className="legal-section">
          <h2>3. Sharing and disclosure</h2>
          <p>
            We do not sell your personal information. We may share information with trusted service providers who help
            us operate the Services (such as hosting, analytics, or payment providers), subject to confidentiality
            obligations. We may also share information if required by law or to protect our rights, safety, or users.
          </p>
        </div>

        <div className="legal-section">
          <h2>4. Data retention</h2>
          <p>
            We retain personal information only as long as needed for the purposes described in this Policy, unless a
            longer retention period is required or permitted by law.
          </p>
        </div>

        <div className="legal-section">
          <h2>5. Security</h2>
          <p>
            We use reasonable technical and organizational measures to protect information. However, no method of
            transmission or storage is completely secure, and we cannot guarantee absolute security.
          </p>
        </div>

        <div className="legal-section">
          <h2>6. Your choices</h2>
          <ul className="legal-list">
            <li>Access and update your account details within the Services.</li>
            <li>Request deletion of your account by contacting us.</li>
            <li>Opt out of non-essential communications at any time.</li>
          </ul>
        </div>

        <div className="legal-section">
          <h2>7. Children's privacy</h2>
          <p>
            The Services are not intended for children under 18. We do not knowingly collect personal information from
            children.
          </p>
        </div>

        <div className="legal-section">
          <h2>8. International data transfers</h2>
          <p>
            Your information may be processed in countries where we or our service providers operate. We take steps to
            ensure your information receives an appropriate level of protection.
          </p>
        </div>

        <div className="legal-section">
          <h2>9. Changes to this policy</h2>
          <p>
            We may update this Privacy Policy from time to time. We will post the updated version and indicate the
            revision date. Continued use of the Services means you accept the updated Policy.
          </p>
        </div>

        <div className="legal-section">
          <h2>10. Contact</h2>
          <p>
            If you have questions or requests related to privacy, contact {" "}
            <a href="mailto:maidkhoon@gmail.com">maidkhoon@gmail.com</a>.
          </p>
        </div>
      </section>
    </div>
  );
}
