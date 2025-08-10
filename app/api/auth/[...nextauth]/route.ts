import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
const handler = NextAuth({
  providers: [
    Google({ clientId: process.env.GOOGLE_CLIENT_ID!, clientSecret: process.env.GOOGLE_CLIENT_SECRET! })
  ],
  callbacks: {
    async signIn({ profile }){
      const domain = process.env.ALLOWED_GOOGLE_DOMAIN;
      if (!domain) return true;
      return profile?.email?.endsWith(`@${domain}`) ?? false;
    },
    async session({ session }){ return session; }
  }
});
export { handler as GET, handler as POST };
