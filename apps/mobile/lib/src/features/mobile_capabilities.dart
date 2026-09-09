const mobileEnabledCapabilities = <String>[
  'chain_catalog',
  'wallet_management',
  'assets',
  'payments',
  'two_factor',
  'pump_trading',
  'dapp_signing',
  'squads_multisig',
  'evm_chains',
  'evm_wallets',
  'evm_assets',
  'evm_payments',
  'evm_dapp_signing',
];

const mobileExcludedCapabilities = <String>[
  'program_deploy',
  'program_upgrade',
  'program_source_build',
  'program_invoke',
];

bool isMobileCapabilityEnabled(String capability) {
  return mobileEnabledCapabilities.contains(capability);
}

bool isMobileCapabilityExcluded(String capability) {
  return mobileExcludedCapabilities.contains(capability);
}
