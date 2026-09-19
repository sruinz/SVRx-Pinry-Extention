<p align="center">
  <img src="svrx-pinry/ico-128.png" width="128" height="128" alt="SVRx Pinry 로고">
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/svrx-pinry/kgncmldoobdakadnojepmalpbmacoonh?authuser=0&amp;hl=ko"><img src="https://img.shields.io/badge/Chrome-%EC%9B%B9%20%EC%8A%A4%ED%86%A0%EC%96%B4-4285F4?logo=googlechrome&amp;logoColor=white" alt="Chrome 웹 스토어에서 SVRx Pinry 설치"></a>
  <a href="https://microsoftedge.microsoft.com/addons/detail/svrx-pinry/gmbgeiddpdblpjdbceoofclpeiikobjj"><img src="https://img.shields.io/badge/Microsoft%20Edge-Add--ons-0078D7?logo=microsoftedge&amp;logoColor=white" alt="Microsoft Edge Add-ons에서 SVRx Pinry 설치"></a>
</p>

# SVRx Pinry

SVRx Pinry는 현재 페이지에서 이미지를 골라 사용자가 설정한 SVRx Pinry 서버에 Pin으로 저장하는 브라우저 확장입니다.

[서버 저장소와 설치 안내](https://github.com/sruinz/SVRx-Pinry) · [확장 프로그램 저장소](https://github.com/sruinz/SVRx-Pinry-Extention)

이미지와 계정을 관리하는 서버를 먼저 설치한 뒤 이 확장 프로그램을 연결하세요.

## 0.1.1 — 다국어 지원

한국어, 영어, 중국어(간체), 프랑스어를 지원합니다. 처음 실행하면 브라우저 언어를 따르며, 지원하지 않는 언어는 영어로 표시합니다. 확장 설정의 **언어**에서 직접 선택하거나 **브라우저 언어**로 되돌릴 수 있습니다.

언어 선택은 이 브라우저에 저장됩니다. 설정 화면, 이미지 선택 화면, 작업·오류 안내와 우클릭 메뉴에 적용되며 서버 인증 정보, 입력 중인 내용과 선택한 이미지는 변경하지 않습니다. 확장 프로그램 설명은 브라우저 언어로 표시됩니다.

## 화면 미리보기

![현재 페이지 이미지 선택 및 일괄 Pin 생성 화면](assets/screenshot-01-image-selection-1280x800.png)

## 공식 지원 환경

- Google Chrome 121 이상
- Chromium 기반 Microsoft Edge

## 설치

스토어에서 바로 설치할 수 있습니다.

- [Chrome 웹 스토어에서 설치](https://chromewebstore.google.com/detail/svrx-pinry/kgncmldoobdakadnojepmalpbmacoonh?authuser=0&hl=ko)
- [Microsoft Edge Add-ons에서 설치](https://microsoftedge.microsoft.com/addons/detail/svrx-pinry/gmbgeiddpdblpjdbceoofclpeiikobjj)

### 수동 설치

1. GitHub 릴리스 ZIP 또는 저장소의 소스 ZIP을 내려받습니다.
2. ZIP 파일의 압축을 풉니다.
3. Chrome 또는 Edge의 확장 관리 페이지에서 개발자 모드를 켭니다.
4. **압축해제된 확장 프로그램을 로드합니다**를 선택합니다. 릴리스 ZIP은 압축을 푼 폴더를, 저장소의 소스 ZIP은 그 안의 `svrx-pinry` 폴더를 선택합니다.

## 서버 연결과 Pin 만들기

확장 옵션에서 SVRx Pinry **서버 주소**와 **API 토큰**을 입력해 저장합니다. 현재 페이지에서 확장을 실행한 뒤 이미지 후보를 선택하고, 기존 보드를 지정하거나 새 보드를 만든 다음 Pin 생성을 완료합니다.

## Firefox 안내

Firefox는 지원하지 않습니다. 공식 지원·배포·검증 대상은 Chrome·Edge로 한정합니다.

## 라이선스와 출처

라이선스는 `LICENSE` 파일에서 확인할 수 있습니다. upstream 프로젝트와 기여 고지는 `UPSTREAM.md`에 안내합니다.
