// USD On-Demand Linux/Shared tenancy EC2 compute rates in ap-south-1.
// Read from AWS Price List GetProducts on 2026-10-05 with regionCode,
// operatingSystem, tenancy, preInstalledSw, capacitystatus, marketoption,
// operation, and instanceType filters. Keep this server-side so rates can be
// refreshed without an iOS release. Other regions/families return no estimate.
const MUMBAI_HOURLY_USD = Object.freeze({
  "m7i.large": 0.10605,
  "m7i.xlarge": 0.2121,
  "m7i.2xlarge": 0.4242,
  "m7i.4xlarge": 0.8484,
  "m7i.8xlarge": 1.6968,
  "m7i.12xlarge": 2.5452,
  "m7i.16xlarge": 3.3936,
  "m7i.24xlarge": 5.0904,
  "m8a.large": 0.12806,
  "m8a.xlarge": 0.25612,
  "m8a.2xlarge": 0.51224,
  "m8a.4xlarge": 1.02448,
  "m8a.8xlarge": 2.04896,
  "m8a.12xlarge": 3.07344,
  "m8a.16xlarge": 4.09792,
  "m8a.24xlarge": 6.14688,
});

export function instancePricing(region, instanceTypes) {
  if (region !== "ap-south-1") return null;
  const hourlyUSD = Object.fromEntries(
    instanceTypes
      .filter((type) => Object.hasOwn(MUMBAI_HOURLY_USD, type))
      .map((type) => [type, MUMBAI_HOURLY_USD[type]]),
  );
  if (Object.keys(hourlyUSD).length !== instanceTypes.length || !instanceTypes.length) return null;
  return {
    currency: "USD",
    basis: "linux-on-demand",
    hoursPerMonth: 730,
    checkedAt: "2026-10-05",
    hourlyUSD,
  };
}
