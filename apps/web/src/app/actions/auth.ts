"use server";

import bcrypt from "bcryptjs";
import { redirect } from "next/navigation";
import { resolveSignInRedirectError, isDbUnavailableError } from "@/lib/auth-errors";
import { signIn } from "@/lib/auth";
import { requireAuth } from "@/lib/auth-utils";
import { createSignupPayment, isPayplugConfigured } from "@/lib/billing/payplug";
import { sealSecret } from "@/lib/crypto/seal";
import { DEFAULT_ORG_MODULES } from "@/lib/modules";
import { prisma } from "@/lib/prisma";
import {
  isStalwartFailure,
  resolveStalwartAccountId,
  updateAccountPassword,
} from "@/lib/stalwart/client";
import { slugify } from "@/lib/utils";
import { authEntryUrl, getSolutionKey } from "@/lib/solution-access";
import { UserRole } from "@prisma/client";
import { z } from "zod";

const signupSchema = z.object({
  orgName: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
});

function resolveAuthEmail(formData: FormData) {
  const composed = (formData.get("email") as string | null)?.trim().toLowerCase();
  if (composed) return composed;

  const localPart = (formData.get("emailLocal") as string | null)?.trim().toLowerCase();
  const domain = (formData.get("emailDomain") as string | null)?.trim().toLowerCase();
  if (localPart && domain) return `${localPart}@${domain}`;

  return "";
}

export async function signupAction(formData: FormData) {
  const solution = getSolutionKey(formData.get("solution"));
  const parsed = signupSchema.safeParse({
    orgName: formData.get("orgName"),
    email: resolveAuthEmail(formData),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    redirect(authEntryUrl(solution, "signup", { error: "invalid" }));
  }

  const { orgName, email, password } = parsed.data;
  const existing = await prisma.user.findUnique({ where: { email } });
  const hash = await bcrypt.hash(password, 12);
  const slug = slugify(orgName);
  const orgSlug = `${slug}-${Date.now()}`;

  let organizationId: string;

  if (existing) {
    const valid = await bcrypt.compare(password, existing.passwordHash);
    if (!valid) redirect(authEntryUrl(solution, "signup", { error: "invalid" }));

    const org = await prisma.organization.create({
      data: {
        name: orgName,
        slug: orgSlug,
        status: "APPROVED",
        approvedAt: new Date(),
        members: {
          create: {
            userId: existing.id,
            role: UserRole.ASSOC_ADMIN,
          },
        },
        modules: { create: DEFAULT_ORG_MODULES },
        subscription: { create: { status: "PENDING_PAYMENT" } },
      },
    });
    organizationId = org.id;
  } else {
    const org = await prisma.organization.create({
      data: {
        name: orgName,
        slug: orgSlug,
        status: "APPROVED",
        approvedAt: new Date(),
        members: {
          create: {
            role: UserRole.ASSOC_ADMIN,
            user: {
              create: {
                email,
                passwordHash: hash,
                role: UserRole.ASSOC_ADMIN,
              },
            },
          },
        },
        modules: { create: DEFAULT_ORG_MODULES },
        subscription: { create: { status: "PENDING_PAYMENT" } },
      },
    });
    organizationId = org.id;
  }

  const paymentResult = isPayplugConfigured()
    ? await createSignupPayment({ email, organizationId, organizationName: orgName })
    : null;

  if (paymentResult?.paymentUrl) {
    if (paymentResult.paymentId || paymentResult.customerId) {
      await prisma.subscription.update({
        where: { organizationId },
        data: {
          payplugPaymentId: paymentResult.paymentId ?? undefined,
          payplugCustomerId: paymentResult.customerId ?? undefined,
        },
      });
    }
    redirect(paymentResult.paymentUrl);
  }

  const loginEmail = existing?.email ?? email;
  try {
    await signIn("credentials", {
      email: loginEmail,
      password,
      redirect: false,
    });
  } catch (err) {
    redirect(authEntryUrl(solution, "login", { error: resolveSignInRedirectError(err) }));
  }

  redirect(isPayplugConfigured() ? "/dashboard/billing?setup=1" : "/dashboard/billing?stub=1");
}

export async function changePasswordAction(
  _prev: { ok: boolean; message: string },
  formData: FormData
): Promise<{ ok: boolean; message: string }> {
  const session = await requireAuth(undefined, { skipPasswordChange: true });

  const password = (formData.get("password") as string) ?? "";
  const confirm = (formData.get("confirm") as string) ?? "";

  if (password.length < 8) {
    return { ok: false, message: "passwordTooShort" };
  }
  if (password !== confirm) {
    return { ok: false, message: "passwordMismatch" };
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    include: {
      mailboxes: {
        include: { mailbox: true },
      },
    },
  });
  if (!user?.mustChangePassword) {
    redirect("/dashboard");
  }

  const hash = await bcrypt.hash(password, 12);

  for (const link of user.mailboxes) {
    const mailbox = link.mailbox;
    const resolved = await resolveStalwartAccountId(mailbox.stalwartAccountId, mailbox.address);
    if (resolved.id) {
      const pwdRes = await updateAccountPassword(resolved.id, password);
      if (isStalwartFailure(pwdRes)) {
        return { ok: false, message: "stalwartError" };
      }
      await prisma.mailbox.update({
        where: { id: mailbox.id },
        data: { credentialsEnc: await sealSecret(password) },
      });
    }
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: hash,
      mustChangePassword: false,
    },
  });

  redirect("/dashboard");
}

export async function loginAction(formData: FormData) {
  const solution = getSolutionKey(formData.get("solution"));
  const email = resolveAuthEmail(formData);
  const password = formData.get("password") as string;
  const callbackUrl = (formData.get("callbackUrl") as string | null)?.trim();

  if (!email || !password) redirect(authEntryUrl(solution, "login", { error: "invalid", callbackUrl }));

  try {
    await signIn("credentials", {
      email,
      password,
      redirect: false,
    });
  } catch (err) {
    redirect(authEntryUrl(solution, "login", { error: resolveSignInRedirectError(err), callbackUrl }));
  }

  let user;
  try {
    user = await prisma.user.findUnique({
      where: { email },
      include: { memberships: true },
    });
  } catch (err) {
    redirect(authEntryUrl(solution, "login", { error: isDbUnavailableError(err) ? "db" : "invalid", callbackUrl }));
  }

  const safeCallback =
    callbackUrl?.startsWith("/") && !callbackUrl.startsWith("//")
      ? callbackUrl
      : null;

  if (user?.mustChangePassword) {
    redirect("/change-password");
  }

  if (safeCallback) {
    redirect(safeCallback);
  }

  if (user?.role === "BUREAU") {
    redirect("/bureau");
  }

  redirect("/dashboard");
}
