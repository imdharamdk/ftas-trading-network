import { Link } from "react-router-dom";

const LAST_UPDATED = "March 21, 2026";

export default function Terms() {
  return (
    <div className="public-page legal-page">
      <header className="public-header">
        <div>
          <span className="eyebrow">Fintech Automated Solutions</span>
          <h1>Terms of Service</h1>
          <p className="muted-copy">These Terms govern your access to the FTAS website, apps, and services.</p>
        </div>
        <nav className="public-links">
          <Link to="/">Login</Link>
          <Link to="/signup">Signup</Link>
          <Link to="/privacy">Privacy Policy</Link>
        </nav>
      </header>

      <section className="legal-card">
        <div className="legal-meta">
          <span className="pill pill-neutral">Last updated: {LAST_UPDATED}</span>
          <span className="pill pill-neutral">Brand: Fintech Automated Solutions (FTAS)</span>
        </div>

        <p>
          Welcome to Fintech Automated Solutions ("FTAS", "we", "us", "our"). By accessing or using our
          website, dashboards, scanners, signals, and related services (collectively, the "Services"), you agree
          to these Terms of Service ("Terms"). If you do not agree, do not use the Services.
        </p>

        <div className="legal-section">
          <h2>1. Eligibility and account</h2>
          <p>
            You must be at least 18 years old to use the Services. You are responsible for maintaining the
            confidentiality of your login credentials and for all activity under your account. You agree to provide
            accurate, current, and complete information during registration and keep it updated.
          </p>
        </div>

        <div className="legal-section">
          <h2>2. Service description</h2>
          <p>
            FTAS provides market scanners, trading signals, analytics, payment and approval workflows, and other
            tools intended for informational and operational purposes. We may add, change, or remove features at any
            time.
          </p>
        </div>

        <div className="legal-section">
          <h2>3. Financial risk disclaimer</h2>
          <p>
            All market data, signals, and analytics are provided for informational purposes only and do not
            constitute investment, financial, legal, or tax advice. Trading and investing involve risk, including the
            possible loss of principal. You are solely responsible for your decisions and outcomes.
          </p>
        </div>

        <div className="legal-section">
          <h2>4. Trials, plans, and payments</h2>
          <p>
            Free trials, subscription plans, and pricing (if offered) are described within the Services. You agree to
            pay applicable fees and taxes. Unless otherwise stated, payments are non-refundable except where required
            by law.
          </p>
        </div>

        <div className="legal-section">
          <h2>5. Acceptable use</h2>
          <ul className="legal-list">
            <li>Do not misuse the Services, including attempting to gain unauthorized access.</li>
            <li>Do not disrupt, overload, or harm our infrastructure or other users.</li>
            <li>Do not use the Services for unlawful, abusive, or fraudulent activities.</li>
            <li>Do not reverse engineer, copy, or resell the Services without written permission.</li>
          </ul>
        </div>

        <div className="legal-section">
          <h2>6. Content and intellectual property</h2>
          <p>
            FTAS and its licensors own all rights, title, and interest in the Services, including software, designs,
            text, graphics, logos, and data compilations. You receive a limited, non-exclusive, non-transferable,
            revocable license to use the Services for your personal or internal business use.
          </p>
        </div>

        <div className="legal-section">
          <h2>7. Third-party services</h2>
          <p>
            The Services may link to or integrate with third-party tools or content. We do not control and are not
            responsible for third-party services, and your use of them is governed by their own terms.
          </p>
        </div>

        <div className="legal-section">
          <h2>8. Suspension and termination</h2>
          <p>
            We may suspend or terminate your access if you violate these Terms, pose a security risk, or for any other
            reason in our sole discretion. You may stop using the Services at any time.
          </p>
        </div>

        <div className="legal-section">
          <h2>9. Disclaimers</h2>
          <p>
            The Services are provided "as is" and "as available" without warranties of any kind, including implied
            warranties of merchantability, fitness for a particular purpose, and non-infringement. We do not guarantee
            uninterrupted or error-free operation.
          </p>
        </div>

        <div className="legal-section">
          <h2>10. Limitation of liability</h2>
          <p>
            To the maximum extent permitted by law, FTAS will not be liable for any indirect, incidental, special,
            consequential, or punitive damages, or any loss of profits, data, or goodwill, arising from or related to
            your use of the Services.
          </p>
        </div>

        <div className="legal-section">
          <h2>11. Indemnity</h2>
          <p>
            You agree to indemnify and hold harmless FTAS and its affiliates, directors, officers, employees, and
            agents from any claims, liabilities, damages, and expenses arising out of your use of the Services or
            violation of these Terms.
          </p>
        </div>

        <div className="legal-section">
          <h2>12. Governing law</h2>
          <p>
            These Terms are governed by the laws of India, without regard to conflict of law principles. You consent to
            the exclusive jurisdiction of courts located in India for disputes arising from these Terms.
          </p>
        </div>

        <div className="legal-section">
          <h2>13. Changes to terms</h2>
          <p>
            We may update these Terms from time to time. If changes are material, we will provide notice within the
            Services. Continued use after an update means you accept the revised Terms.
          </p>
        </div>

        <div className="legal-section">
          <h2>14. Contact</h2>
          <p>
            Questions about these Terms can be sent to {" "}
            <a href="mailto:maidkhoon@gmail.com">maidkhoon@gmail.com</a>.
          </p>
        </div>
      </section>
    </div>
  );
}
