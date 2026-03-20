function envToBool(value) {
  if (value === undefined || value === null || value === "") return null;
  const v = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(v)) return true;
  if (["false", "0", "no", "n"].includes(v)) return false;
  return null;
}

function resolveAutoStart({ envCrypto, envStock, storedCrypto, storedStock, defaultAutoStart }) {
  const base = Boolean(defaultAutoStart);
  return {
    autoStartCrypto: (envCrypto ?? storedCrypto ?? base) === true,
    autoStartStock: (envStock ?? storedStock ?? base) === true,
    defaultAutoStart: base,
    sources: {
      envCrypto,
      envStock,
      storedCrypto,
      storedStock,
    },
  };
}

module.exports = { envToBool, resolveAutoStart };
