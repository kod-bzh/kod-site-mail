import { SolutionAccessPage, type SolutionAccessParams } from "@/components/auth/solution-access-page";

export default async function SignupPage({ searchParams }: { searchParams: Promise<SolutionAccessParams> }) {
  return <SolutionAccessPage solution="mail" mode="signup" params={await searchParams} contextual={false} />;
}
