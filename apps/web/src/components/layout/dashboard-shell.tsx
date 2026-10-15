import { Sidebar, type NavGroup, type NavItem } from "@/components/ui/sidebar";
import { auth } from "@/lib/auth";
import { getOrgId } from "@/lib/auth-utils";
import { listAccessibleMailboxes } from "@/lib/mail/mailbox-access";
import { getOrganizationModules } from "@/lib/modules";
import { getUserMemberships } from "@/lib/tenant";
import { TenantSwitcher } from "@/components/layout/tenant-switcher";
import { getT } from "@/i18n/t";

export async function DashboardShell({
  children,
  orgName,
}: {
  children: React.ReactNode;
  orgName?: string;
}) {
  const session = await auth();
  const t = await getT("dashboard");
  const tc = await getT("common");

  const orgId = session ? getOrgId(session) : null;
  const modules = orgId ? await getOrganizationModules(orgId) : null;
  const accessibleMailboxes =
    session?.user.id && orgId
      ? await listAccessibleMailboxes(session.user.id, orgId)
      : [];
  const sharedMailNavItems: NavItem[] = accessibleMailboxes
    .map((m) => ({
      id: `mail-${m.id}`,
      href: `/dashboard/mail/${m.id}`,
      label: m.isDelegated
        ? `${m.displayName ?? m.address} (${t("delegatedMailbox")})`
        : (m.displayName ?? m.address),
      icon: "mail" as const,
    }));

  const overview: NavItem = {
    id: "overview",
    href: "/dashboard",
    label: t("overview"),
    icon: "overview",
  };

  const organizationItems: NavItem[] = [
    ...(modules?.mail
      ? [
          {
            id: "users",
            href: "/dashboard/users",
            label: t("users"),
            icon: "members" as const,
          },
        ]
      : []),
    ...(modules?.members
      ? [
          {
            id: "members",
            href: "/dashboard/members",
            label: t("members"),
            icon: "members" as const,
          },
        ]
      : []),
  ];

  const accountingItems: NavItem[] = modules?.accounting
    ? [
        {
          id: "accounting",
          href: "/dashboard/accounting",
          label: t("sections.accounting"),
          icon: "bureau",
        },
      ]
    : [];

  const messagingItems: NavItem[] = modules?.mail
    ? [
        ...sharedMailNavItems,
        {
          id: "shared-mailboxes",
          href: "/dashboard/shared-mailboxes",
          label: t("sharedMailboxes"),
          icon: "forward",
        },
        {
          id: "aliases",
          href: "/dashboard/aliases",
          label: t("aliases"),
          icon: "forward",
        },
      ]
    : [];

  const calendarItems: NavItem[] = modules?.calendar
    ? [
        {
          id: "calendar",
          href: "/dashboard/calendar",
          label: t("sections.calendar"),
          icon: "overview",
        },
      ]
    : [];

  const groups: NavGroup[] = [
    ...(organizationItems.length > 0
      ? [
          {
            id: "organization",
            label: t("sections.organization"),
            items: organizationItems,
          } satisfies NavGroup,
        ]
      : []),
    ...(accountingItems.length > 0
      ? [
          {
            id: "accounting",
            label: t("sections.accounting"),
            items: accountingItems,
          } satisfies NavGroup,
        ]
      : []),
    ...(calendarItems.length > 0
      ? [
          {
            id: "calendar",
            label: t("sections.calendar"),
            items: calendarItems,
          } satisfies NavGroup,
        ]
      : []),
    ...(messagingItems.length > 0
      ? [
          {
            id: "messaging",
            label: t("sections.messaging"),
            items: messagingItems,
          } satisfies NavGroup,
        ]
      : []),
    {
      id: "platform",
      label: t("sections.platform"),
      items: [
        {
          id: "modules",
          href: "/dashboard/modules",
          label: t("modules"),
          icon: "modules",
        },
        {
          id: "domains",
          href: "/dashboard/domains",
          label: t("domains"),
          icon: "globe",
        },
        { id: "mail-delivery", href: "/dashboard/mail-delivery", label: t("mailDelivery"), icon: "mail" },
        {
          id: "api-keys",
          href: "/dashboard/api-keys",
          label: t("apiKeys"),
          icon: "modules",
        },
        {
          id: "billing",
          href: "/dashboard/billing",
          label: t("billing"),
          icon: "billing",
        },
        ...(session?.user.role === "BUREAU"
          ? [
              {
                id: "bureau",
                href: "/bureau",
                label: t("bureau"),
                icon: "bureau" as const,
              },
              {
                id: "health",
                href: "/dashboard/admin/health",
                label: t("healthDiagnostics"),
                icon: "health" as const,
              },
            ]
          : []),
      ],
    },
  ];

  const memberships = session?.user.id
    ? await getUserMemberships(session.user.id)
    : [];

  const tenants = memberships.map((m) => ({
    id: m.organizationId,
    name: m.organization.name,
    status: m.organization.status,
  }));

  return (
    <div className="flex min-h-screen bg-neutral-50/80">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-encre focus:px-3 focus:py-2 focus:text-sm focus:text-white"
      >
        {tc("skipToContent")}
      </a>
      <Sidebar overview={overview} groups={groups} logoAlt={tc("appName")} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center justify-between gap-4 border-b border-canal bg-white px-6">
          <div className="min-w-0">
            {orgName && (
              <p className="truncate text-sm font-medium text-ardoise">{orgName}</p>
            )}
          </div>
          {session?.user && (
            <TenantSwitcher
              tenants={tenants}
              activeTenantId={session.user.organizationId}
              userEmail={session.user.email}
            />
          )}
        </header>
        <main id="main-content" className="flex-1 scroll-mt-14 p-6 md:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
