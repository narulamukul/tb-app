const DC: Record<string,{api:string;accounts:string}> = {
  IN: { api: 'https://www.zohoapis.in', accounts: 'https://accounts.zoho.in' },
  US: { api: 'https://www.zohoapis.com', accounts: 'https://accounts.zoho.com' },
  EU: { api: 'https://www.zohoapis.eu', accounts: 'https://accounts.zoho.eu' },
  UK: { api: 'https://www.zohoapis.eu', accounts: 'https://accounts.zoho.eu' },
};
export function zohoClientFor(region: 'IN'|'US'|'EU'|'UK'){
  const ids: Record<string,{id?:string;secret?:string}> = {
    IN: { id: process.env.ZOHO_IN_CLIENT_ID, secret: process.env.ZOHO_IN_CLIENT_SECRET },
    US: { id: process.env.ZOHO_US_CLIENT_ID, secret: process.env.ZOHO_US_CLIENT_SECRET },
    EU: { id: process.env.ZOHO_EU_CLIENT_ID, secret: process.env.ZOHO_EU_CLIENT_SECRET },
    UK: { id: process.env.ZOHO_UK_CLIENT_ID, secret: process.env.ZOHO_UK_CLIENT_SECRET },
  };
  return { ...DC[region], ...ids[region] };
}
