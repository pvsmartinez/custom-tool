import iconPng from '../assets/icon.png';
import './SplashScreen.css';

interface Props {
  visible: boolean;
}

export default function SplashScreen({ visible }: Props) {
  return (
    <div className={`splash ${visible ? 'splash--visible' : 'splash--hidden'}`}>
      <img src={iconPng} alt="Cafezin" className="splash-icon" />
      <h1 className="splash-title">Cafezin</h1>
      <p className="splash-tagline">Just Chilling</p>
    </div>
  );
}
