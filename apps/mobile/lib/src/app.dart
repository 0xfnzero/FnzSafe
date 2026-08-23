import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import 'features/app_scope.dart';
import 'features/assets_screen.dart';
import 'features/confirmation_screen.dart';
import 'features/dashboard_screen.dart';
import 'features/dapp_browser_screen.dart';
import 'features/feature_screen.dart';
import 'features/scanner_screen.dart';
import 'features/security_screen.dart';
import 'features/send_screen.dart';
import 'features/squads_screen.dart';
import 'features/wallets_screen.dart';

final _router = GoRouter(
  initialLocation: '/',
  routes: [
    GoRoute(
      path: '/',
      builder: (context, state) => const DashboardScreen(),
    ),
    GoRoute(
      path: '/lock',
      builder: (context, state) => const WalletsScreen(),
    ),
    GoRoute(
      path: '/wallets',
      builder: (context, state) => const WalletsScreen(),
    ),
    GoRoute(
      path: '/assets',
      builder: (context, state) => const AssetsScreen(),
    ),
    GoRoute(
      path: '/send',
      builder: (context, state) => const SendScreen(),
    ),
    GoRoute(
      path: '/security',
      builder: (context, state) => const SecurityScreen(),
    ),
    GoRoute(
      path: '/trading',
      builder: (context, state) => FeatureScreen(
        title: 'Pump Trading',
        description: 'PumpFun/PumpSwap sell and cashback workflows.',
        actions: [
          FeatureAction(
            label: 'Preview Pump sell',
            icon: Icons.show_chart,
            run: (bridge, network, wallet) {
              final publicKey = wallet?.publicKey ??
                  'FnzPreviewWallet111111111111111111111111';
              return bridge.previewPumpSell(
                network: network,
                walletPublicKey: publicKey,
                mint: 'So11111111111111111111111111111111111111112',
              );
            },
          ),
        ],
      ),
    ),
    GoRoute(
      path: '/dapps',
      builder: (context, state) => FeatureScreen(
        title: 'dApps',
        description:
            'Mobile WebView, Solana provider injection, preview, and user-confirmed signing.',
        actions: [
          FeatureAction(
            label: 'Open browser',
            icon: Icons.open_in_browser,
            run: (bridge, network, wallet) async =>
                const NavigationTarget('/browser'),
          ),
          FeatureAction(
            label: 'Preview dApp request',
            icon: Icons.public,
            run: (bridge, network, wallet) {
              final publicKey = wallet?.publicKey ??
                  'FnzPreviewWallet111111111111111111111111';
              return bridge.previewDappSign(
                network: network,
                walletPublicKey: publicKey,
                appName: 'Demo dApp',
              );
            },
          ),
        ],
      ),
    ),
    GoRoute(
      path: '/squads',
      builder: (context, state) => const SquadsScreen(),
    ),
    GoRoute(
      path: '/settings',
      builder: (context, state) => FeatureScreen(
        title: 'Settings',
        description:
            'Network, RPC, security policy, diagnostics, and internal testing controls.',
        actions: [
          FeatureAction(
            label: 'Bridge health',
            icon: Icons.health_and_safety_outlined,
            run: (bridge, network, wallet) => bridge.health(),
          ),
        ],
      ),
    ),
    GoRoute(
      path: '/confirm',
      builder: (context, state) => const ConfirmationScreen(),
    ),
    GoRoute(
      path: '/scan',
      builder: (context, state) => const ScannerScreen(),
    ),
    GoRoute(
      path: '/browser',
      builder: (context, state) => const DappBrowserScreen(),
    ),
  ],
);

class FnzSafeMobileApp extends StatelessWidget {
  const FnzSafeMobileApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      title: 'FnzSafe',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xff14b8a6),
          brightness: Brightness.dark,
        ),
        useMaterial3: true,
        cardTheme: const CardThemeData(
          margin: EdgeInsets.zero,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.all(Radius.circular(8)),
          ),
        ),
      ),
      routerConfig: _router,
      builder: (context, child) =>
          AppScope(child: child ?? const SizedBox.shrink()),
    );
  }
}
