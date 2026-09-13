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
import 'features/settings_screen.dart';
import 'features/squads_screen.dart';
import 'features/wallets_screen.dart';
import 'ui/wallet_ui.dart';

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
      builder: (context, state) => const SettingsScreen(),
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
      themeMode: ThemeMode.system,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: fnzBlue,
          primary: fnzBlue,
          secondary: fnzOrange,
          surface: Colors.white,
          brightness: Brightness.light,
        ),
        scaffoldBackgroundColor: fnzCanvas,
        useMaterial3: true,
        dividerColor: const Color(0xffdfe2e8),
        appBarTheme: const AppBarTheme(
          backgroundColor: Colors.white,
          foregroundColor: fnzInk,
          surfaceTintColor: Colors.transparent,
          elevation: 0,
        ),
        navigationBarTheme: const NavigationBarThemeData(
          backgroundColor: Colors.white,
          indicatorColor: Color(0xffe6eaff),
          elevation: 1,
        ),
        cardTheme: const CardThemeData(
          margin: EdgeInsets.zero,
          elevation: 0,
          color: Colors.white,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.all(Radius.circular(8)),
            side: BorderSide(color: Color(0xffdfe2e8)),
          ),
        ),
        inputDecorationTheme: const InputDecorationTheme(
          filled: true,
          fillColor: Colors.white,
          border: OutlineInputBorder(
            borderRadius: BorderRadius.all(Radius.circular(8)),
          ),
        ),
      ),
      darkTheme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xff8ea2ff),
          primary: const Color(0xffaebcff),
          secondary: const Color(0xffffa452),
          brightness: Brightness.dark,
        ),
        useMaterial3: true,
        scaffoldBackgroundColor: const Color(0xff111318),
        dividerColor: const Color(0xff343840),
        appBarTheme: const AppBarTheme(
          backgroundColor: Color(0xff181b21),
          surfaceTintColor: Colors.transparent,
          elevation: 0,
        ),
        navigationBarTheme: const NavigationBarThemeData(
          backgroundColor: Color(0xff181b21),
          indicatorColor: Color(0xff303a68),
          elevation: 1,
        ),
        cardTheme: const CardThemeData(
          margin: EdgeInsets.zero,
          elevation: 0,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.all(Radius.circular(8)),
            side: BorderSide(color: Color(0xff343840)),
          ),
        ),
      ),
      routerConfig: _router,
      builder: (context, child) =>
          AppScope(child: child ?? const SizedBox.shrink()),
    );
  }
}
