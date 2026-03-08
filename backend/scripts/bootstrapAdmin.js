require("dotenv").config();

const bcrypt = require("bcryptjs");
const { USER_ROLES, createUser, normalizeEmail, sanitizeUser } = require("../models/User");
const { mutateCollection } = require("../storage/fileStore");

function getArg(flag) {
  const prefix = `--${flag}=`;
  const match = process.argv.find((item) => item.startsWith(prefix));
  return match ? match.slice(prefix.length) : "";
}

function resolveInput() {
  const name = getArg("name") || process.env.ADMIN_BOOTSTRAP_NAME || "FTAS Admin";
  const email = normalizeEmail(getArg("email") || process.env.ADMIN_BOOTSTRAP_EMAIL);
  const password = getArg("password") || process.env.ADMIN_BOOTSTRAP_PASSWORD || "";

  if (!email) {
    throw new Error("Admin email is required. Use --email=you@example.com or ADMIN_BOOTSTRAP_EMAIL.");
  }

  if (!password || password.length < 6) {
    throw new Error("Admin password must be at least 6 characters.");
  }

  return {
    email,
    name,
    password,
  };
}

async function main() {
  const input = resolveInput();
  const passwordHash = await bcrypt.hash(input.password, 10);

  const result = await mutateCollection("users", (records) => {
    const existing = records.find((user) => user.email === input.email);

    if (existing) {
      const updated = {
        ...existing,
        name: input.name,
        passwordHash,
        role: USER_ROLES.ADMIN,
        isActive: true,
        updatedAt: new Date().toISOString(),
      };

      return {
        records: records.map((user) => (user.id === existing.id ? updated : user)),
        value: {
          action: "updated",
          user: updated,
        },
      };
    }

    const user = createUser({
      email: input.email,
      name: input.name,
      passwordHash,
      role: USER_ROLES.ADMIN,
      isActive: true,
      plan: "PREMIUM",
      subscriptionStatus: "ACTIVE",
      subscriptionEndsAt: null,
    });

    return {
      records: [user, ...records],
      value: {
        action: "created",
        user,
      },
    };
  });

  console.log(
    JSON.stringify(
      {
        action: result.action,
        user: sanitizeUser(result.user),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
