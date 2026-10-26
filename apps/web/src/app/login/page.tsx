import { SolutionAccessPage, type SolutionAccessParams } from "@/components/auth/solution-access-page";

export default async function LoginPage({ searchParams }: { searchParams: Promise<SolutionAccessParams> }) {
  return <SolutionAccessPage solution="mail" mode="login" params={await searchParams} contextual={false} />;
}
