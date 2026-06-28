type PasswordRequirementKey = "length" | "letter" | "number" | "symbol";

type PasswordRequirement = {
  key: PasswordRequirementKey;
  label: string;
  isMet: (password: string) => boolean;
};

type AuthLikeError = {
  message?: string;
  code?: string;
  status?: number;
};

const passwordRequirements: PasswordRequirement[] = [
  {
    key: "length",
    label: "At least 8 characters",
    isMet: (password) => password.length >= 8,
  },
  {
    key: "letter",
    label: "Includes a letter",
    isMet: (password) => /[A-Za-z]/.test(password),
  },
  {
    key: "number",
    label: "Includes a number",
    isMet: (password) => /\d/.test(password),
  },
  {
    key: "symbol",
    label: "Includes a symbol",
    isMet: (password) => /[^A-Za-z0-9]/.test(password),
  },
];

export function getPasswordRequirementStatus(password: string) {
  return passwordRequirements.map((requirement) => ({
    key: requirement.key,
    label: requirement.label,
    isMet: requirement.isMet(password),
  }));
}

export function validatePassword(password: string) {
  const requirements = getPasswordRequirementStatus(password);

  return {
    isValid: requirements.every((requirement) => requirement.isMet),
    requirements,
  };
}

export function getPasswordRequirementsText() {
  return passwordRequirements.map((requirement) => requirement.label);
}

export function passwordsMatch(password: string, confirmPassword: string) {
  return password === confirmPassword;
}

export function mapAuthErrorMessage(error: unknown, fallback = "Authentication failed.") {
  if (!error || typeof error !== "object") {
    return fallback;
  }

  const candidate = error as AuthLikeError;
  const message = candidate.message?.toLowerCase() ?? "";
  const code = candidate.code?.toLowerCase() ?? "";

  if (message.includes("invalid login credentials")) {
    return "Email or password is incorrect.";
  }

  if (message.includes("email not confirmed")) {
    return "Please confirm your email address, then sign in.";
  }

  if (message.includes("already registered") || message.includes("user already registered")) {
    return "This email may already have an account. Try signing in or resetting your password.";
  }

  if (
    code.includes("weak_password") ||
    message.includes("weak password") ||
    message.includes("password should be") ||
    message.includes("password must") ||
    message.includes("password requirements")
  ) {
    return `Password must meet these rules: ${getPasswordRequirementsText().join(", ")}.`;
  }

  if (
    message.includes("auth session missing") ||
    message.includes("invalid token") ||
    message.includes("token has expired") ||
    message.includes("expired")
  ) {
    return "This password reset link is invalid or expired. Request a new reset link.";
  }

  if (message.includes("rate limit") || candidate.status === 429) {
    return "Too many attempts. Wait a little, then try again.";
  }

  return candidate.message && candidate.message.length <= 120 ? candidate.message : fallback;
}
