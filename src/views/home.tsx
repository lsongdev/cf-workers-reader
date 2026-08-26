import type { User } from "../types";
import { Layout } from "./layout";

export interface HomePageProps {
  name: string;
  user: User;
  csrf: string;
  error?: string | null;
}

export function HomePage({ name, user, csrf, error }: HomePageProps) {
  return (
    <Layout title={name} user={user} csrf={csrf} error={error}>
      <section class="card">
        <p>{name} · Application</p>
        <h1>Welcome{user.name ? `, ${user.name}` : ""}</h1>
        <p>You are signed in. Replace this view with your application's home experience.</p>
      </section>
    </Layout>
  );
}
