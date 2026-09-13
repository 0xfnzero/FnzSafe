import Flutter
import UIKit

class SceneDelegate: FlutterSceneDelegate {
  private var privacyShield: UIView?

  override func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    super.scene(scene, willConnectTo: session, options: connectionOptions)
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(screenCaptureChanged),
      name: UIScreen.capturedDidChangeNotification,
      object: nil
    )
    updatePrivacyShield()
  }

  override func sceneWillResignActive(_ scene: UIScene) {
    super.sceneWillResignActive(scene)
    showPrivacyShield()
  }

  private func showPrivacyShield() {
    guard let window, privacyShield == nil else { return }
    let shield = UIView(frame: window.bounds)
    shield.backgroundColor = UIColor.systemBackground
    shield.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    let label = UILabel()
    label.text = "FnzSafe locked"
    label.font = UIFont.preferredFont(forTextStyle: .headline)
    label.translatesAutoresizingMaskIntoConstraints = false
    shield.addSubview(label)
    NSLayoutConstraint.activate([
      label.centerXAnchor.constraint(equalTo: shield.centerXAnchor),
      label.centerYAnchor.constraint(equalTo: shield.centerYAnchor),
    ])
    window.addSubview(shield)
    privacyShield = shield
  }

  override func sceneDidBecomeActive(_ scene: UIScene) {
    super.sceneDidBecomeActive(scene)
    updatePrivacyShield()
  }

  @objc private func screenCaptureChanged() {
    updatePrivacyShield()
  }

  private func updatePrivacyShield() {
    let isCaptured = window?.screen.isCaptured ?? UIScreen.main.isCaptured
    if isCaptured || window?.windowScene?.activationState != .foregroundActive {
      showPrivacyShield()
    } else {
      privacyShield?.removeFromSuperview()
      privacyShield = nil
    }
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }
}
